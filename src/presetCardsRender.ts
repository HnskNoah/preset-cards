import { openai_settings } from '@sillytavern/scripts/openai';
import { AVAILABLE_MODELS, LOGO_BASE } from './constants.js';
import { readMeta } from './meta.js';
import type { Preset } from './meta.js';
import { applyCachedBackgrounds } from './cache.js';
import type { CardsContext } from './presetCardsContext.js';

/** 编辑预设保存后就地刷新卡片：描述 / 模型 chips / 背景图 / footer 采样标签。 */
export function refreshCardInPlace(ctx: CardsContext, idx: number): void {
    const preset = openai_settings[idx] as Preset;
    const meta = readMeta(preset);
    const card = ctx.dialog.find(`.preset_card[data-preset-index="${idx}"]`);

    // Description
    if (meta.description) {
        let descEl = card.find('.preset_card_desc');
        if (descEl.length === 0) {
            card.find('.preset_card_body').prepend('<div class="preset_card_desc"></div>');
            descEl = card.find('.preset_card_desc');
        }
        descEl.text(meta.description).attr('title', meta.description);
    } else {
        card.find('.preset_card_desc').remove();
    }

    // Model chips
    const chipsEl = card.find('.preset_card_tags');
    chipsEl.empty();
    if (meta.models.length > 0) {
        if (chipsEl.length === 0) {
            const profilesEl = card.find('.preset_card_profiles_section');
            if (profilesEl.length > 0) profilesEl.before('<div class="preset_card_tags"></div>');
            else card.find('.preset_card_body').append('<div class="preset_card_tags"></div>');
        }
        for (const mid of meta.models) {
            const def = AVAILABLE_MODELS.find(m => m.id === mid);
            const logoHtml = def ? `<img src="${LOGO_BASE + def.logo}" alt="" />` : '';
            const label = def ? def.label : mid;
            card.find('.preset_card_tags').append(
                `<span class="preset_card_chip" title="${label}">${logoHtml}${label}</span>`,
            );
        }
    } else {
        chipsEl.remove();
    }

    // Background image
    const bgImage = meta.bgImage || '';
    card.toggleClass('has_bg', !!bgImage);
    let bgEl = card.find('.preset_card_bg_image');
    if (bgImage) {
        if (bgEl.length === 0) {
            card.append('<div class="preset_card_bg_image"></div>');
            bgEl = card.find('.preset_card_bg_image');
        }
        bgEl.css('background-image', 'none').attr('data-bg-url', bgImage);
        applyCachedBackgrounds(card);
    } else {
        bgEl.remove();
    }

    // Footer tags (T/P/K/Ctx/Tok/Stream)
    const footerEl = card.find('.preset_card_footer');
    if (footerEl.length > 0) {
        footerEl.empty();
        const tags: string[] = [];
        if (preset['temperature'] != null) tags.push(`<span class="preset_card_tag" title="Temperature"><span class="tag_label">T</span><span class="tag_value">${preset['temperature']}</span></span>`);
        if (preset['top_p'] != null) tags.push(`<span class="preset_card_tag" title="Top P"><span class="tag_label">P</span><span class="tag_value">${preset['top_p']}</span></span>`);
        if (preset['top_k'] != null) tags.push(`<span class="preset_card_tag" title="Top K"><span class="tag_label">K</span><span class="tag_value">${preset['top_k']}</span></span>`);
        if (preset['openai_max_context']) tags.push(`<span class="preset_card_tag" title="Context"><span class="tag_label">Ctx</span><span class="tag_value">${preset['openai_max_context']}</span></span>`);
        if (preset['openai_max_tokens']) tags.push(`<span class="preset_card_tag" title="Max Tokens (Response)"><span class="tag_label">Tok</span><span class="tag_value">${preset['openai_max_tokens']}</span></span>`);
        if (preset['stream_openai']) tags.push('<span class="preset_card_tag" title="Streaming"><span class="tag_value">Stream</span></span>');
        footerEl.append(tags.join(''));
    }
}
