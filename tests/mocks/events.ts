/** ST events 模块的最小 mock：真实事件总线（on/emit），测试可注册钩子并触发。 */

type Listener = (...args: any[]) => unknown;

const listeners = new Map<string, Set<Listener>>();

export const event_types: Record<string, string> = {
    OAI_PRESET_CHANGED_BEFORE: 'oai-preset-changed-before',
    OAI_PRESET_CHANGED_AFTER: 'oai-preset-changed-after',
    PRESET_CHANGED: 'preset-changed',
    PRESET_DELETED: 'preset-deleted',
    SETTINGS_UPDATED: 'settings-updated',
};

export const eventSource = {
    emit: async (event: string, ...args: unknown[]): Promise<boolean> => {
        const set = listeners.get(event);
        if (!set) return true;
        for (const listener of [...set]) {
            await listener(...args);
        }
        return true;
    },
    on: (event: string, listener: Listener): void => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(listener);
    },
    once: (event: string, listener: Listener): void => {
        const wrapper = async (...args: unknown[]): Promise<unknown> => {
            eventSource.removeListener(event, wrapper);
            return listener(...args);
        };
        eventSource.on(event, wrapper);
    },
    removeListener: (event: string, listener: Listener): void => {
        listeners.get(event)?.delete(listener);
    },
};

/** 测试辅助：清空已注册监听器（setup beforeEach 调用）。 */
export function resetEventSource(): void {
    listeners.clear();
}
