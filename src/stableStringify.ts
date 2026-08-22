/** 稳定序列化：对象键递归排序，语义相同但键序不同的对象序列化一致。
 * 供导入去重指纹与捕获净零比较共用（原先私有于 importExport，捕获侧需要后下沉共享）。 */
export function stableStringify(value: unknown): string {
    return JSON.stringify(value, (_key, v) => {
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            const record = v as Record<string, unknown>;
            const sorted: Record<string, unknown> = {};
            for (const k of Object.keys(record).sort()) sorted[k] = record[k];
            return sorted;
        }
        return v;
    });
}
