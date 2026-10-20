# DSH для 1С — исходники сборки

Это форк [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Ветка `1c/main` — наша
линия поверх тега апстрима `dsh-v0.2.0-rc.2`: русская оболочка и мастер установки, офлайн-каталог
плагинов для 1С, собственный канал обновлений. Ниже по истории — DeepSeek Harness без изменений.

| Что | Где |
| --- | --- |
| Установщик `.exe` | [релизы сборки](https://github.com/Mempemp/DSH-1C-deskop-bundle/releases/latest) |
| Состав каталога: плагины, MCP-серверы, правила | [DSH-1C-deskop-bundle](https://github.com/Mempemp/DSH-1C-deskop-bundle), `installer-flavor.yml` |
| Порядок сборки и релиза | там же, `docs/development.md` и `docs/release-runbook.md` |
| Агентный рантайм, другие платформы, документация | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) |

## Сборка

Каталог 1С живёт отдельным репозиторием, поэтому клонировать нужно оба, рядом:

```sh
git clone https://github.com/Mempemp/deepseek-harness.git      # ветка 1c/main — по умолчанию
git clone https://github.com/Mempemp/DSH-1C-deskop-bundle.git
cd deepseek-harness
corepack enable                                                # packageManager: pnpm@11.7.0
pnpm install --frozen-lockfile
node apps/desktop/scripts/prepare-1c-catalog.mjs               # каталог из ../DSH-1C-deskop-bundle
pnpm --dir apps/desktop run package:win:x64:unsigned           # установщик и манифесты фида
```

Готовое лежит в `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/`: установщик,
`.blockmap` и `dsh1c.yml`.

Нужны Windows x64, Node.js 24 и Visual Studio Build Tools 2022 с C++. Сборка идёт под TTY: без
терминала pnpm падает с `stdin is not a tty`. Если каталог лежит в другом месте — задайте путь
через `DSH_1C_BUNDLE_ROOT`, тогда соседний клон не нужен.

`apps/desktop/installer-catalog/` в репозиторий не коммитится: он собирается из `installer-flavor.yml`
и требует сети — плагины качаются из npm, git и из этого же каталога сборки.

Замечания по коду — в тот репозиторий, который отвечает за файл: каталог, редакция notifier и
релизы в `DSH-1C-deskop-bundle`, клиент и установщик — здесь. Лицензия [MIT](LICENSE), как и у
апстрима; сторонние зависимости перечислены в [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
