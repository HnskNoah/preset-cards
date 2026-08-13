import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        alias: {
            '@sillytavern/script': path.resolve(__dirname, 'tests/mocks/script.ts'),
            '@sillytavern/scripts/openai': path.resolve(__dirname, 'tests/mocks/openai.ts'),
            '@sillytavern/scripts/i18n': path.resolve(__dirname, 'tests/mocks/i18n.ts'),
            '@sillytavern/scripts/popup': path.resolve(__dirname, 'tests/mocks/popup.ts'),
            '@sillytavern/scripts/utils': path.resolve(__dirname, 'tests/mocks/utils.ts'),
            '@sillytavern/scripts/events': path.resolve(__dirname, 'tests/mocks/events.ts'),
            '@sillytavern/scripts/extensions': path.resolve(__dirname, 'tests/mocks/extensions.ts'),
            '@sillytavern/scripts/tool-calling': path.resolve(__dirname, 'tests/mocks/tool-calling.ts'),
            '@sillytavern/scripts/slash-commands/SlashCommand': path.resolve(__dirname, 'tests/mocks/SlashCommand.ts'),
            '@sillytavern/scripts/slash-commands/SlashCommandParser': path.resolve(__dirname, 'tests/mocks/SlashCommandParser.ts'),
        },
    },
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        setupFiles: ['tests/setup.ts'],
    },
});
