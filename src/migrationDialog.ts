// migrationDialog：预设更新迁移向导 UI（切片 3/4）。
// 流程：选来源/目标预设 → dry-run 报告 + 策略选项 + 冲突逐项解决（不解决完不能应用，已决策）
// → 替换式落盘（presetMigration.executeMigration）→ 结果摘要。
// 逻辑全部下沉 presetMigration / core/migration；本文件只做 DOM 组装与事件绑定。
import { openai_settings, openai_setting_names } from '@sillytavern/scripts/openai';
import { POPUP_TYPE, callGenericPopup } from '@sillytavern/scripts/popup';
import type { Preset } from './meta.js';
import { L } from './i18n.js';
import { planMigration, executeMigration, listMigrationSourceNames } from './presetMigration.js';
import type { MigrationPlan } from './core/migration/plan.js';
import type { ConflictResolution, MigrationApplyOptions } from './core/migration/apply.js';
import type { CardsContext } from './presetCardsContext.js';
import { refreshGrid } from './presetCardsState.js';

/** 值预览：content 等长文本截断，完整值放 title。 */
function previewValue(value: unknown): { text: string; title: string } {
    const full = value === undefined ? '(∅)' : typeof value === 'string' ? value : JSON.stringify(value);
    const text = full.length > 60 ? `${full.slice(0, 60)}…` : full;
    return { text, title: full };
}

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

/** 第一步：选择来源（旧预设，须有配置）与目标（新预设）。返回 [sourceName, targetName] 或 null。 */
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
    for (const name of allNames) {
        if (name === (sourceSelect.val() as string)) continue;
        targetSelect.append($('<option></option>').val(name).text(name));
    }
    targetRow.append(targetSelect);
    container.append(targetRow);

    // 换来源时目标下拉里排除来源自身
    sourceSelect.on('change', () => {
        const src = sourceSelect.val() as string;
        targetSelect.empty();
        for (const name of allNames) {
            if (name === src) continue;
            targetSelect.append($('<option></option>').val(name).text(name));
        }
    });

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
    orderStrategy: 'keep-mine' | 'follow-new';
    mountNew: 'factory' | 'unmounted';
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

/** 第二步：dry-run 报告 + 选项 + 冲突解决。resolve(true) = 按当前选项与解决项应用。 */
function showMigrationReport(
    plan: MigrationPlan,
    sourceName: string,
    targetName: string,
): Promise<{ apply: boolean; options: WizardOptions; resolutions: ConflictResolution[] } | null> {
    const options: WizardOptions = { orderStrategy: 'keep-mine', mountNew: 'factory' };
    const resolutions = new Map<string, unknown>();

    const container = $('<div class="preset_cards_migration"></div>');
    container.append($('<h4></h4>').text(L('Migration report')));
    container.append($('<div class="preset_cards_migration_hint"></div>')
        .text(`${sourceName} → ${targetName}`));

    // 摘要
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

    if (s.removed > 0) {
        const removed = plan.profileReports.flatMap((r) => r.danglingReferences);
        if (removed.length > 0) {
            container.append($('<div class="preset_cards_migration_hint"></div>')
                .text(`${L('Removed entries (references kept, skipped on load)')}: ${[...new Set(removed)].join(', ')}`));
        }
    }

    // 策略选项
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

    // 冲突解决：逐字段三选一（旧出厂值 / 新版值 / 我的值），不解决完不能应用（已决策）
    const applyBtn = $('<button class="menu_button"></button>').text(L('Apply migration'));
    const totalConflicts = s.conflicts;
    if (totalConflicts > 0) {
        const conflictBox = $('<div class="preset_cards_migration_conflicts"></div>');
        conflictBox.append($('<h5></h5>').text(L('Resolve conflicts')));
        const counter = $('<div class="preset_cards_migration_hint"></div>');
        conflictBox.append(counter);
        applyBtn.prop('disabled', true);

        const updateCounter = (): void => {
            counter.text(`${L('Resolved')}: ${resolutions.size} / ${totalConflicts}`);
            applyBtn.prop('disabled', resolutions.size < totalConflicts);
        };
        updateCounter();

        for (const report of plan.profileReports) {
            if (report.fieldConflicts.length === 0) continue;
            const group = $('<div class="preset_cards_migration_conflict_group"></div>');
            group.append($('<div class="preset_cards_migration_conflict_profile"></div>')
                .text(`${report.profileName} (${report.kind === 'prompt_base' ? 'Base' : 'Delta'})`));
            for (const c of report.fieldConflicts) {
                const row = $('<div class="preset_cards_migration_conflict_row"></div>');
                const key = `${report.profileId}	${c.newIdentifier}	${c.field}`;
                row.append($('<span class="preset_cards_migration_field"></span>')
                    .text(`${c.entryName} · ${c.field}`));
                for (const [label, value] of [
                    [L('Factory (old)'), c.base],
                    [L('New version'), c.theirs],
                    [L('My edit'), c.ours],
                ] as [string, unknown][]) {
                    const preview = previewValue(value);
                    const btn = $('<button class="menu_button"></button>')
                        .attr('title', preview.title)
                        .on('click', () => {
                            row.find('button').removeClass('active');
                            btn.addClass('active');
                            resolutions.set(key, value);
                            updateCounter();
                        });
                    btn.append($('<span class="preset_cards_migration_choice_label"></span>').text(label));
                    btn.append($('<br>'));
                    btn.append($('<span class="preset_cards_migration_choice_value"></span>').text(preview.text));
                    row.append(btn);
                }
                group.append(row);
            }
            conflictBox.append(group);
        }
        container.append(conflictBox);
    }

    const actions = $('<div class="preset_cards_migration_actions"></div>');
    const cancelBtn = $('<button class="menu_button"></button>').text(L('Cancel'));
    actions.append(applyBtn, cancelBtn);
    container.append(actions);

    return showWithResolver<{ apply: boolean; options: WizardOptions; resolutions: ConflictResolution[] } | null>(container, (settle) => {
        applyBtn.on('click', () => {
            const list: ConflictResolution[] = [];
            for (const report of plan.profileReports) {
                for (const c of report.fieldConflicts) {
                    const value = resolutions.get(`${report.profileId}	${c.newIdentifier}	${c.field}`);
                    if (value !== undefined) {
                        list.push({ profileId: report.profileId, newIdentifier: c.newIdentifier, field: c.field, value });
                    }
                }
            }
            settle({ apply: true, options, resolutions: list });
        });
        cancelBtn.on('click', () => settle(null));
    });
}

/** 迁移向导入口（卡片页头部按钮）：选预设 → 报告/冲突 → 应用 → 刷新卡片页。 */
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

    // 默认来源 = 第一个有配置的预设；目标默认 = 当前激活卡片（若非来源）
    const picked = await pickPresets(sources, allNames);
    if (!picked) return;
    const [sourceName, targetName] = picked;

    const sourcePreset = presetByName(sourceName);
    const targetIdx = openai_setting_names[targetName];
    const targetPreset = presetByName(targetName);
    if (!sourcePreset || targetIdx === undefined || !targetPreset) return;

    const plan = planMigration(sourcePreset, targetPreset);
    const decision = await showMigrationReport(plan, sourceName, targetName);
    if (!decision?.apply) return;

    const applyOptions: MigrationApplyOptions = {
        orderStrategy: decision.options.orderStrategy,
        mountNew: decision.options.mountNew,
        resolutions: decision.resolutions,
    };
    const result = await executeMigration(sourcePreset, targetName, targetIdx, applyOptions);
    if (result.status === 'blocked') {
        void callGenericPopup(L('Unresolved conflicts remain'), POPUP_TYPE.TEXT);
        return;
    }
    if (result.status === 'persist-failed') return;

    const r = result.report!;
    void callGenericPopup(
        L('Migration applied') +
        `：${r.profilesMigrated} profiles · ${L('Preserved my edits')}: ${r.preservedOurs} · ${L('Followed new version')}: ${r.netZeroDropped + r.mountFollowed}` +
        (r.danglingKept.length > 0 ? ` · ${L('Removed entries (references kept, skipped on load)')}: ${new Set(r.danglingKept).size}` : ''),
        POPUP_TYPE.TEXT,
    );
    await refreshGrid(ctx);
}
