// 自包含的 SillyTavern 模块声明 —— 只覆盖 preset-cards 实际用到的 API。
// 仓库克隆到任何位置都能通过类型检查,无需指向本地 ST 源码树。

declare module '@sillytavern/script' {
    export function getRequestHeaders(options?: { omitContentType?: boolean }): Record<string, string>;
    export function saveSettingsDebounced(loopCounter?: number): void;
}

declare module '@sillytavern/scripts/extensions' {
    export function renderExtensionTemplateAsync(
        extensionName: string,
        templateId: string,
        templateData?: Record<string, any>,
        sanitize?: boolean,
        localize?: boolean,
    ): Promise<string>;
}

declare module '@sillytavern/scripts/i18n' {
    export function t(strings: TemplateStringsArray, ...values: unknown[]): string;
}

declare module '@sillytavern/scripts/utils' {
    export function download(content: string | Blob, filename: string, contentType?: string): void;
    export function cancelDebounce(func: (...args: unknown[]) => unknown): void;
}

declare module '@sillytavern/scripts/events' {
    export const event_types: {
        OAI_PRESET_CHANGED_BEFORE: string;
        OAI_PRESET_CHANGED_AFTER: string;
        PRESET_CHANGED: string;
        PRESET_DELETED: string;
        [key: string]: string;
    };
    export const eventSource: {
        emit(event: string, ...args: unknown[]): Promise<boolean>;
        [key: string]: unknown;
    };
}

declare module '@sillytavern/scripts/slash-commands/SlashCommand' {
    export class SlashCommand {
        static fromProps(props: {
            name: string;
            callback: (...args: unknown[]) => Promise<unknown> | unknown;
            helpString?: string;
            [key: string]: unknown;
        }): SlashCommand;
    }
}

declare module '@sillytavern/scripts/slash-commands/SlashCommandParser' {
    export class SlashCommandParser {
        static addCommandObject(command: unknown): void;
    }
}

declare module '@sillytavern/scripts/popup' {
    export const POPUP_TYPE: {
        TEXT: string;
        CONFIRM: string;
        [key: string]: string;
    };
    export const POPUP_RESULT: {
        AFFIRMATIVE: string;
        NEGATIVE: string;
        [key: string]: string;
    };
    export function callGenericPopup(
        content: JQuery<HTMLElement> | string,
        type: string,
        inputValue?: string,
        popupOptions?: Record<string, any>,
    ): Promise<string | null>;
    export class Popup {
        static show: Record<string, (...args: any[]) => Promise<any>>;
        constructor(
            content: JQuery<HTMLElement> | string,
            type: string,
            inputValue?: string,
            popupOptions?: Record<string, any>,
        );
        show(): Promise<string | null>;
        complete(result: string | number): Promise<void>;
        completeCancelled(): Promise<void>;
    }
}

declare module '@sillytavern/scripts/openai' {
    /** 每一项: [selector, setting_name, is_checkbox, is_connection] */
    export const settingsToUpdate: Record<string, [string, string, boolean, boolean]>;
    export function getChatCompletionPreset(settings?: Record<string, unknown>): Record<string, unknown>;
    export const chat_completion_sources: Record<string, string>;
    export let openai_setting_names: Record<string, number>;
    export let openai_settings: Record<string, unknown>[];
    export const oai_settings: {
        preset_settings_openai: string | null;
        bind_preset_to_connection?: boolean;
        extensions?: Record<string, unknown>;
        [key: string]: unknown;
    };
    export const promptManager: {
        render(afterTryGenerate?: boolean): void;
        renderDebounced: () => void;
        saveServiceSettings(): Promise<void>;
        configuration: {
            promptOrder: {
                strategy: 'global' | 'character';
                dummyId?: number;
            };
        };
        activeCharacter?: { id: number } | null;
    } | null;
}
