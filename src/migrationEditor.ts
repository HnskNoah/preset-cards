// migrationEditor：编辑器迁移模式（pcmanager 式图形化冲突解决，v2 设计 §2）。
// 复用 profile-editor 的 pc-* 布局与样式：左栏 prompt 列表（待解决冲突置顶成组 + ⚠ 徽章），
// 右栏三方合并面板（旧出厂值 / 新版值 / 我的修改 三选 + 手动编辑第四选项）。
// 每次解决操作后全量重放（冲突集是 resolutions 的纯函数），左栏与计数实时刷新——
// 上层解决可能让下层冲突新增或消失（rebase 语义）。未解决完「应用迁移」禁用；关闭即弃（零落盘）。
import { POPUP_TYPE, Popup, callGenericPopup } from '@sillytavern/scripts/popup';
import type { Preset } from './meta.js';
import { L } from './i18n.js';
import { buildMigrationSource, buildMigrationTarget, executeMigration } from './presetMigration.js';
import {
    previewMigration,
    type LevelFieldConflict,
    type MigrationReplayResult,
} from './core/migration/apply.js';
import { resolutionKey, type ConflictResolution, type MigrationConflictField, type ReplayOptions } from './core/migration/replay.js';
import type { CardsContext } from './presetCardsContext.js';
import { refreshGrid } from './presetCardsState.js';

/** 手动编辑表单的字段控件（第四选项，按字段类型给控件）。 */
function manualEditInput(field: MigrationConflictField, value: unknown): JQuery<HTMLElement> {
    if (field === 'content') {
        return $('<textarea class="text_pole textarea_compact pc-migration-manual-input"></textarea>')
            .val(typeof value === 'string' ? value : '');
    }
    if (field === 'injection_position') {
        const select = $('<select class="text_pole textarea_compact pc-migration-manual-input" data-pc-value-type="number"></select>');
        for (const [label, v] of [['Relative', 0], ['In-chat', 1], ['Absolute Depth', 2]] as [string, number][]) {
            select.append($('<option></option>').val(String(v)).text(`${label} (${v})`));
        }
        select.val(String(typeof value === 'number' ? value : 0));
        return select;
    }
    if (field === 'role') {
        const select = $('<select class="text_pole textarea_compact pc-migration-manual-input"></select>');
        for (const r of ['system', 'user', 'assistant']) {
            select.append($('<option></option>').val(r).text(r));
        }
        select.val(typeof value === 'string' && ['system', 'user', 'assistant'].includes(value) ? value : 'system');
        return select;
    }
    if (typeof value === 'boolean') {
        const select = $('<select class="text_pole textarea_compact pc-migration-manual-input" data-pc-value-type="boolean"></select>');
        select.append($('<option></option>').val('true').text('true'));
        select.append($('<option></option>').val('false').text('false'));
        select.val(String(value));
        return select;
    }
    if (field === 'model' || (value !== undefined && value !== null && typeof value === 'object')) {
        return $('<textarea class="text_pole textarea_compact pc-migration-manual-input" data-pc-value-type="json"></textarea>')
            .val(value === undefined ? '' : JSON.stringify(value, null, 2));
    }
    if (field === 'injection_depth' || field.startsWith('sampling.')) {
        return $('<input type="number" class="text_pole textarea_compact pc-migration-manual-input" data-pc-value-type="number"></input>')
            .val(typeof value === 'number' ? value : 0);
    }
    return $('<input type="text" class="text_pole textarea_compact pc-migration-manual-input"></input>')
        .val(typeof value === 'string' ? value : '');
}

function parseManualValue(_field: MigrationConflictField, el: JQuery<HTMLElement>): unknown {
    const raw = ((el.val() as string) ?? '').trim();
    const type = el.attr('data-pc-value-type');
    if (type === 'number') {
        if (raw === '') return undefined;
        const n = Number(raw);
        return Number.isFinite(n) ? n : undefined;
    }
    if (type === 'boolean') return raw === 'true';
    if (type === 'json') {
        if (raw === '') return undefined;
        try { return JSON.parse(raw); } catch { return undefined; }
    }
    return raw === '' ? undefined : raw;
}

function previewText(value: unknown): { text: string; title: string } {
    const full = value === undefined ? '(∅)' : typeof value === 'string' ? value : JSON.stringify(value);
    return { text: full.length > 80 ? `${full.slice(0, 80)}…` : full, title: full };
}

function keyOf(c: LevelFieldConflict): string {
    return resolutionKey(c.profileId, c.newIdentifier, c.field);
}

interface PendingResolution {
    value: unknown;
    signature: string;
}

/** 编辑器迁移模式会话。返回是否完成应用（false = 用户关闭放弃）。 */
export async function openMigrationEditor(params: {
    ctx: CardsContext;
    sourcePreset: Preset;
    targetPreset: Preset;
    targetName: string;
    targetIdx: number;
    orderStrategy: ReplayOptions['orderStrategy'];
    mountNew: NonNullable<ReplayOptions['mountNew']>;
    carryMissingDefs: boolean;
}): Promise<boolean> {
    const { ctx, sourcePreset, targetPreset, targetName, targetIdx } = params;
    const source = buildMigrationSource(sourcePreset);
    const target = buildMigrationTarget(targetPreset);
    const resolutions = new Map<string, PendingResolution>();

    const resolutionsList = (): ConflictResolution[] =>
        [...resolutions.entries()].map(([k, r]) => {
            const [profileId, newIdentifier, field] = JSON.parse(k) as [string, string, MigrationConflictField];
            return { profileId, newIdentifier, field, signature: r.signature, value: r.value };
        });
    const recompute = (): MigrationReplayResult => previewMigration(source, target, {
        orderStrategy: params.orderStrategy,
        mountNew: params.mountNew,
        resolutions: resolutionsList(),
    });

    let current = recompute();
    let selectedEntry: string | null = current.conflicts[0]?.newIdentifier ?? null;

    // ---- 布局骨架（复用 pc-manager 样式）----
    const dialog = $('<div id="preset_migration_editor" class="pc-manager-container"></div>');
    const layout = $('<div class="pc-layout"></div>');
    const leftPane = $('<div class="pc-left-pane"></div>');
    const header = $('<div class="pc-header"></div>');
    const headerRow = $('<div class="pc-header-preset-row"></div>');
    headerRow.append($('<span class="pc-header-preset-name"></span>')
        .text(`${L('Migrate configurations to updated preset')}: ${targetName}`));
    const closeBtn = $('<button id="pc-mig-btn-close" class="pc-top-action-btn" title="Close"><i class="fa-solid fa-times"></i></button>');
    headerRow.append(closeBtn);
    header.append(headerRow);
    const counterRow = $('<div class="pc-header-breadcrumb-row"></div>');
    const counterEl = $('<div class="pc-header-breadcrumb"></div>');
    counterRow.append(counterEl);
    header.append(counterRow);
    const actionsRow = $('<div class="pc-header-actions-row"></div>');
    const actionsCenter = $('<div class="pc-header-actions-center"></div>');
    const applyBtn = $('<button id="pc-mig-btn-apply" class="pc-top-action-btn pc-btn-commit"></button>')
        .append($('<i class="fa-solid fa-check"></i> '), $('<span class="pc-btn-label"></span>').text(L('Apply migration')));
    actionsCenter.append(applyBtn);
    actionsRow.append(actionsCenter);
    header.append(actionsRow);
    leftPane.append(header);
    const listEl = $('<div class="pc-prompt-list"></div>');
    leftPane.append(listEl);
    const rightPane = $('<div class="pc-right-pane"></div>');
    const diffArea = $('<div class="pc-diff-area"></div>');
    rightPane.append(diffArea);
    layout.append(leftPane, rightPane);
    dialog.append(layout);

    function render(): void {
        current = recompute();
        counterEl.text(current.conflicts.length > 0
            ? `${L('Resolve conflicts')}: ${current.conflicts.length}`
            : L('All conflicts resolved'));
        // 设计 §115：未解决完不能应用——视觉禁用，而非仅点击静默拦截
        applyBtn.toggleClass('disabled', current.conflicts.length > 0)
            .prop('disabled', current.conflicts.length > 0);
        // 仅在无选中时自动定位首个冲突：普通条目点击后选中项不在冲突集是预期态
        //（查看迁移后预览），不能弹回——旧行为把点击变成视觉 no-op。
        if (selectedEntry === null && current.conflicts.length > 0) {
            selectedEntry = current.conflicts[0].newIdentifier;
        }
        renderLeft();
        renderRight();
    }

    function renderLeft(): void {
        listEl.empty();
        const conflictEntries = [...new Set(current.conflicts.map((c) => c.newIdentifier))];
        if (conflictEntries.length > 0) {
            const group = $('<div class="pc-migration-conflict-group"></div>');
            group.append($('<div class="pc-migration-group-title"></div>')
                .text(`${L('Resolve conflicts')} (${current.conflicts.length})`));
            for (const entryId of conflictEntries) {
                const cs = current.conflicts.filter((c) => c.newIdentifier === entryId);
                const name = cs[0].entryName;
                const card = $('<div class="pc-prompt-card pc-migration-conflict-card"></div>')
                    .attr('data-identifier', entryId)
                    .toggleClass('selected', entryId === selectedEntry);
                card.append($('<i class="fa-solid fa-triangle-exclamation pc-migration-warn"></i>'));
                card.append($('<span class="pc-card-name"></span>')
                    .attr('title', `${name} · ${cs.map((c) => c.field).join(', ')}`)
                    .text(name));
                card.append($('<span class="pc-role-badge"></span>').text(String(cs.length)));
                card.on('click', () => { selectedEntry = entryId; render(); });
                group.append(card);
            }
            listEl.append(group);
        }

    }

    function renderRight(): void {
        diffArea.empty();
        if (selectedEntry === null) {
            diffArea.append($('<div class="pc-migration-placeholder"></div>')
                .text(L('Select a conflicted entry to resolve')));
            return;
        }
        const entryConflicts = current.conflicts
            .filter((c) => c.newIdentifier === selectedEntry)
            .sort((a, b) => a.chainLevel - b.chainLevel);
        if (entryConflicts.length === 0) {
            diffArea.append($('<div class="pc-migration-placeholder"></div>')
                .text(L('No conflicts on this entry')));
            return;
        }
        for (const c of entryConflicts) diffArea.append(buildConflictPanel(c));
    }

    function buildConflictPanel(c: LevelFieldConflict): JQuery<HTMLElement> {
        const panel = $('<div class="pc-migration-panel"></div>');
        panel.append($('<div class="pc-migration-panel-title"></div>')
            .text(`${c.entryName} · ${c.field} · ${c.profileName} (${c.chainLevel === 0 ? 'Base' : `L${c.chainLevel}`})`));

        const choices: [string, unknown][] = [
            [L('Factory (old)'), c.base],
            [L('New version'), c.theirs],
            [L('My edit'), c.ours],
        ];
        const key = keyOf(c);
        const row = $('<div class="pc-migration-choices"></div>');
        for (const [label, value] of choices) {
            const preview = previewText(value);
            const btn = $('<button class="menu_button pc-migration-choice"></button>')
                .attr('title', preview.title)
                .toggleClass('active', resolutions.has(key) && resolutions.get(key)?.value === value);
            btn.append($('<span class="pc-migration-choice-label"></span>').text(label));
            btn.append($('<span class="pc-migration-choice-value"></span>').text(preview.text));
            btn.on('click', () => { resolutions.set(key, { value, signature: c.signature }); render(); });
            row.append(btn);
        }
        panel.append(row);

        // 第四选项：手动编辑合并值（预填「我的修改」；content 为文本域，行级融合人工完成）
        const manualWrap = $('<div class="pc-migration-manual"></div>');
        manualWrap.append($('<span class="pc-migration-choice-label"></span>').text(L('Manually edit merged value')));
        const input = manualEditInput(c.field, c.ours);
        const manualBtn = $('<button class="menu_button"></button>').text(L('Use edited value'));
        const currentResolution = resolutions.get(key);
        const isManual = currentResolution !== undefined && !choices.some(([, v]) => currentResolution.value === v);
        if (isManual) input.val(typeof currentResolution.value === 'string' ? currentResolution.value : JSON.stringify(currentResolution.value, null, 2));
        manualBtn.on('click', () => {
            const parsed = parseManualValue(c.field, input);
            if (parsed === undefined) return;
            resolutions.set(key, { value: parsed, signature: c.signature });
            render();
        });
        manualWrap.append(input, manualBtn);
        panel.append(manualWrap);
        return panel;
    }

    render();

    const popup = new Popup(dialog, POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: false,
        transparent: true,
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
    closeBtn.on('click', () => popup.completeCancelled());

    let applied = false;
    let applying = false;
    applyBtn.on('click', async () => {
        if (applying || current.conflicts.length > 0) return;
        // executeMigration 是追加式落盘且含网络往返：防重入守卫，双击不会写入两份 profiles。
        applying = true;
        try {
            const result = await executeMigration(sourcePreset, targetName, targetIdx, {
                orderStrategy: params.orderStrategy,
                mountNew: params.mountNew,
                carryMissingDefs: params.carryMissingDefs,
                resolutions: resolutionsList(),
            });
            if (result.status === 'persist-failed') return;
            if (result.status === 'blocked') {
                void callGenericPopup(result.blockedReason ?? L('Unresolved conflicts remain'), POPUP_TYPE.TEXT);
                return;
            }
            applied = true;
            const r = result.report!;
            void callGenericPopup(
                `${L('Migration applied')}：${r.profilesMigrated} profiles · ${L('Preserved my edits')}: ${r.preservedOurs} · ${L('Followed new version')}: ${r.netZeroDropped + r.mountFollowed}`,
                POPUP_TYPE.TEXT,
            );
            await refreshGrid(ctx);
            popup.completeCancelled();
        } finally {
            applying = false;
        }
    });

    await popup.show();
    return applied;
}
