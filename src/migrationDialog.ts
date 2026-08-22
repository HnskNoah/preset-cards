// migrationDialog：预设更新迁移向导（v2 收缩版，设计稿 migration-replay-editor-design.md §2.1）。
// 职责：选来源/目标预设 → dry-run 报告（摘要 + 策略选项）→ 无冲突直接应用；
// 有冲突 → 进入编辑器迁移模式（migrationEditor，pcmanager 式图形化解决）。
// 逻辑全部下沉 presetMigration / core/migration；本文件只做 DOM 组装与事件绑定。
import { openai_settings, openai_setting_names } from '@sillytavern/scripts/openai';
import { POPUP_TYPE, callGenericPopup } from '@sillytavern/scripts/popup';
import type { Preset } from './meta.js';
import { L } from './i18n.js';
import { planMigration, executeMigration, listMigrationSourceNames } from './presetMigration.js';
import type { MigrationReplayResult } from './core/migration/apply.js';
import type { ReplayOptions } from './core/migration/replay.js';
import type { CardsContext } from './presetCardsContext.js';
import { refreshGrid } from './presetCardsState.js';
import { openMigrationEditor } from './migrationEditor.js';

function presetByName(name: string): Preset | undefined {
    const idx = openai_setting_names[name];
    return idx === undefined ? undefined : openai_settings[idx] as Preset | undefined;
}

/** 弹窗展示 + resolver 模式（同 chooseFromOptions）：按钮/关闭任一先到先得。 */
function showWithResolver<T>(container: JQuery<HTMLElement>, onSettle: (resolve: (v: T | null) => void) => void): Promise<T | null> {
    let resolver: (v: T | null) => void;
    let settled = false;
    const promise = new Promise<T | null>((r) => { resolver = r; });
    const settle = (v: T | null): void => {
        if (settled) return;
        settled = true;
        resolver(v);
        container.closest('.popup').find('.popup-controls .menu_button').click();
    };
    onSettle(settle);
    void callGenericPopup(container, POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: '',
        onClose: () => settle(null),
        wide: true,
        allowVerticalScrolling: true,
    });
    return promise;
}

/** 第一步：选择来源（旧预设，须有配置）与目标（新预设）。 */
function pickPresets(sources: string[], allNames: string[]): Promise<[string, string] | null> {
    const container = $('<div class="preset_cards_migration"></div>');
    container.append($('<h4></h4>').text(L('Migrate configurations to updated preset')));
    container.append($('<div class="preset_cards_migration_hint"></div>').text(L('Copy all profiles from an old preset onto its updated version, merging your edits with the author\'s changes (three-way merge).')));

    const sourceRow = $('<div class="preset_cards_migration_row"></div>');
    sourceRow.append($('<label></label>').text(L('Source preset (old)')));
    const sourceSelect = $('<select class="text_pole textarea_compact"></select>');
    for (const name of sources) sourceSelect.append($('<option></option>').val(name).text(name));
    sourceRow.append(sourceSelect);
    container.append(sourceRow);

    const targetRow = $('<div class="preset_cards_migration_row"></div>');
    targetRow.append($('<label></label>').text(L('Target preset (updated)')));
    const targetSelect = $('<select class="text_pole textarea_compact"></select>');
    const rebuildTargets = (): void => {
        targetSelect.empty();
        for (const name of allNames) {
            if (name === (sourceSelect.val() as string)) continue;
            targetSelect.append($('<option></option>').val(name).text(name));
        }
    };
    rebuildTargets();
    sourceSelect.on('change', rebuildTargets);
    targetRow.append(targetSelect);
    container.append(targetRow);

    const actions = $('<div class="preset_cards_migration_actions"></div>');
    const nextBtn = $('<button class="menu_button"></button>').text(L('Analyze migration'));
    const cancelBtn = $('<button class="menu_button"></button>').text(L('Cancel'));
    actions.append(nextBtn, cancelBtn);
    container.append(actions);

    return showWithResolver<[string, string]>(container, (settle) => {
        nextBtn.on('click', () => settle([sourceSelect.val() as string, targetSelect.val() as string]));
        cancelBtn.on('click', () => settle(null));
    });
}

interface WizardOptions {
    orderStrategy: ReplayOptions['orderStrategy'];
    mountNew: NonNullable<ReplayOptions['mountNew']>;
}

/** 策略选项行（radio 组）。 */
function optionRow(label: string, name: string, choices: [string, string][], value: string, onChange: (v: string) => void): JQuery<HTMLElement> {
    const row = $('<div class="preset_cards_migration_row"></div>');
    row.append($('<label></label>').text(label));
    const group = $('<div></div>');
    for (const [text, val] of choices) {
        const id = `preset_cards_migration_${name}_${val}`;
        const input = $('<input type="radio"></input>').attr('id', id).attr('name', name).val(val);
        if (val === value) input.prop('checked', true);
        input.on('change', () => { if ((input.prop('checked') as boolean)) onChange(val); });
        group.append(input, $('<label></label>').attr('for', id).text(text));
    }
    row.append(group);
    return row;
}

/** 第二步：dry-run 报告 + 策略选项。冲突时进入编辑器解决（v2），无冲突直接应用。 */
function showMigrationReport(
    plan: MigrationReplayResult,
    sourceName: string,
    targetName: string,
): Promise<{ proceed: boolean; options: WizardOptions } | null> {
    const options: WizardOptions = { orderStrategy: 'keep-mine', mountNew: 'factory' };

    const container = $('<div class="preset_cards_migration"></div>');
    container.append($('<h4></h4>').text(L('Migration report')));
    container.append($('<div class="preset_cards_migration_hint"></div>').text(`${sourceName} → ${targetName}`));

    const s = plan.summary;
    const summary = $('<div class="preset_cards_migration_summary"></div>');
    summary.append($('<span class="tag"></span>').text(`${L('Matched')}: ${s.matched}`));
    if (s.fingerprintRemapped > 0) summary.append($('<span class="tag"></span>').text(`${L('Remapped')}: ${s.fingerprintRemapped}`));
    summary.append($('<span class="tag"></span>').text(`${L('Updated by author')}: ${s.definitionChanged}`));
    summary.append($('<span class="tag"></span>').text(`${L('Added')}: ${s.added}`));
    summary.append($('<span class="tag"></span>').text(`${L('Removed')}: ${s.removed}`));
    if (s.ambiguous > 0) summary.append($('<span class="tag"></span>').text(`${L('Ambiguous')}: ${s.ambiguous}`));
    summary.append($('<span class="tag"></span>').text(`${L('Conflicts')}: ${s.conflicts}`));
    container.append(summary);

    if (plan.report.danglingKept.length > 0) {
        container.append($('<div class="preset_cards_migration_hint"></div>')
            .text(`${L('Removed entries (references kept, skipped on load)')}: ${[...new Set(plan.report.danglingKept)].join(', ')}`));
    }

    container.append(optionRow(
        L('Order strategy'), 'order', [
            [L('Keep my order'), 'keep-mine'],
            [L('Follow new preset order'), 'follow-new'],
        ], options.orderStrategy, (v) => { options.orderStrategy = v as WizardOptions['orderStrategy']; },
    ));
    container.append(optionRow(
        L('New entries'), 'mount', [
            [L('Follow factory'), 'factory'],
            [L('Keep unmounted'), 'unmounted'],
        ], options.mountNew, (v) => { options.mountNew = v as WizardOptions['mountNew']; },
    ));

    if (s.conflicts > 0) {
        container.append($('<div class="preset_cards_migration_hint"></div>')
            .text(L('Conflicts are resolved graphically in the profile editor. Upper-level choices may add or remove lower-level conflicts (rebase semantics).')));
    }

    const actions = $('<div class="preset_cards_migration_actions"></div>');
    const proceedBtn = $('<button class="menu_button"></button>')
        .text(s.conflicts > 0 ? L('Resolve conflicts in editor') : L('Apply migration'));
    const cancelBtn = $('<button class="menu_button"></button>').text(L('Cancel'));
    actions.append(proceedBtn, cancelBtn);
    container.append(actions);

    return showWithResolver<{ proceed: boolean; options: WizardOptions } | null>(container, (settle) => {
        proceedBtn.on('click', () => settle({ proceed: true, options }));
        cancelBtn.on('click', () => settle(null));
    });
}

/** 迁移向导入口（卡片页头部按钮）。 */
export async function openMigrationWizard(ctx: CardsContext): Promise<void> {
    const sources = listMigrationSourceNames('');
    if (sources.length === 0) {
        void callGenericPopup(L('No presets with configurations to migrate'), POPUP_TYPE.TEXT);
        return;
    }
    const allNames = (openai_settings as Preset[])
        .map((p) => (p && typeof p.name === 'string' ? p.name : ''))
        .filter(Boolean);
    if (allNames.length < 2) {
        void callGenericPopup(L('Need at least two presets to migrate'), POPUP_TYPE.TEXT);
        return;
    }

    const picked = await pickPresets(sources, allNames);
    if (!picked) return;
    const [sourceName, targetName] = picked;

    const sourcePreset = presetByName(sourceName);
    const targetIdx = openai_setting_names[targetName];
    const targetPreset = presetByName(targetName);
    if (!sourcePreset || targetIdx === undefined || !targetPreset) return;

    const plan = planMigration(sourcePreset, targetPreset);
    const decision = await showMigrationReport(plan, sourceName, targetName);
    if (!decision?.proceed) return;
    const { orderStrategy, mountNew } = decision.options;

    if (plan.summary.conflicts > 0) {
        // 有冲突 → 编辑器迁移模式（图形化解决 + 应用；未解决完不能应用）
        await openMigrationEditor({ ctx, sourcePreset, targetPreset, targetName, targetIdx, orderStrategy, mountNew });
        return;
    }

    // 无冲突 → 直接应用
    const result = await executeMigration(sourcePreset, targetName, targetIdx, { orderStrategy, mountNew });
    if (result.status === 'persist-failed') return;
    const r = result.report!;
    void callGenericPopup(
        `${L('Migration applied')}：${r.profilesMigrated} profiles · ${L('Preserved my edits')}: ${r.preservedOurs} · ${L('Followed new version')}: ${r.netZeroDropped + r.mountFollowed}`,
        POPUP_TYPE.TEXT,
    );
    await refreshGrid(ctx);
}
