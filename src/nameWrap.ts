import { isRepeatedRunName } from './presetList.js';

const NAME_SELECTOR = [
    '.preset_card_name',
    '.preset_card_source_line',
    '.preset_card_profile_name',
    '.preset_card_profile_entry_name',
    '.pc-card-name',
    '.pc-card-id',
    '.pc-editor-header h3',
    '.pc-header-preset-name',
    '.pc-breadcrumb-item',
].join(', ');

/** 对容器内所有名字元素应用省略/换行策略：
 * 超长的单个重复字符/符号串加 .pc-name-nowrap 保留省略号，其余元素自动换行（CSS 默认）。 */
export function applyNameWrap(root: JQuery<HTMLElement>): void {
    root.find(NAME_SELECTOR).each((_, el) => {
        const $el = $(el);
        $el.toggleClass('pc-name-nowrap', isRepeatedRunName($el.text()));
    });
}
