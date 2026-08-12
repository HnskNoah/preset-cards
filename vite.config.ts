import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// ST 模块在浏览器里通过服务器根绝对路径加载(不受插件安装目录影响),
// 源码用 @sillytavern/* 惯例写法,vite 在 resolveId 阶段重写为绝对路径并标记 external,
// 这样 ST 自身的代码不会被打进产物,仓库克隆到任何位置都能构建。
function stResolver(): Plugin {
    return {
        name: 'preset-cards-st-resolver',
        enforce: 'pre',
        resolveId(id) {
            if (id === '@sillytavern/script') {
                return { id: '/script.js', external: true };
            }
            if (id.startsWith('@sillytavern/')) {
                return { id: `/${id.replace('@sillytavern/', '')}.js`, external: true };
            }
            return null;
        },
    };
}

export default defineConfig(({ mode }) => ({
    plugins: [stResolver()],
    build: {
        rollupOptions: {
            input: path.resolve(__dirname, 'src/index.ts'),
            preserveEntrySignatures: 'strict',
            output: {
                format: 'es',
                entryFileNames: '[name].js',
                assetFileNames: '[name].[ext]',
            },
        },
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: false,
        minify: mode === 'production',
        target: 'esnext',
    },
}));
