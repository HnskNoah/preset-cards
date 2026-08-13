export const POPUP_TYPE = { TEXT: 'text', CONFIRM: 'confirm', INPUT: 'input' };
export const POPUP_RESULT = { AFFIRMATIVE: 'affirmative', NEGATIVE: 'negative' };

export function callGenericPopup(
    _content: unknown,
    _type: string,
    _inputValue?: string,
    _popupOptions?: Record<string, unknown>,
): Promise<string | null> {
    return Promise.resolve(POPUP_RESULT.AFFIRMATIVE);
}

export class Popup {
    static show = {
        input: async (): Promise<string | null> => null,
    };

    constructor(
        _content: unknown,
        _type: string,
        _inputValue?: string,
        _popupOptions?: Record<string, unknown>,
    ) {}

    show(): Promise<string | null> {
        return Promise.resolve(null);
    }

    complete(_result: string | number): Promise<void> {
        return Promise.resolve();
    }

    completeCancelled(): Promise<void> {
        return Promise.resolve();
    }
}
