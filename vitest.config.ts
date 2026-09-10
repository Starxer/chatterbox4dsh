import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // DSH rc.1 keeps the component library's runtime dependencies (clsx, katex,
    // shiki, micromark-*, ...) in that package's own devDependencies, so a
    // standalone install cannot load the real package from unit tests.
    // Substitute a local stand-in — see tests/stubs/ui-primitives.tsx.
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(
        new URL('./tests/stubs/ui-primitives.tsx', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    clearMocks: true,
    server: { deps: { inline: [/@deepseek-ai\/dsh-client-/, /katex/] } },
  },
})
