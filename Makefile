PLUGIN_ID     := com.narlei.broadlink.ulanziPlugin
INSTALL_BASE  := $(HOME)/Library/Application Support/Ulanzi/UlanziDeck/Plugins
INSTALL_DIR   := $(INSTALL_BASE)/$(PLUGIN_ID)
DIST_DIR      := dist
ZIP           := $(DIST_DIR)/$(PLUGIN_ID).zip
APP_NAME      := Ulanzi Studio
APP_PROC      := UlanziDeck

.PHONY: help package install restart clean bump_major bump_minor bump_patch

help:
	@echo "Available targets:"
	@echo "  make package     - Build a distributable ZIP at $(ZIP)"
	@echo "  make install     - Sync plugin + restart $(APP_NAME)"
	@echo "  make restart     - Restart $(APP_NAME) only"
	@echo "  make clean       - Remove $(DIST_DIR)/"
	@echo "  make bump_patch  - Bump patch version"

package: clean
	@echo "→ Reinstalling production deps in $(PLUGIN_ID)..."
	@rm -rf "$(PLUGIN_ID)/node_modules"
	@cd "$(PLUGIN_ID)" && npm install --omit=dev --silent && node scripts/prune-deps.mjs
	@mkdir -p $(DIST_DIR)
	@zip -r "$(ZIP)" "$(PLUGIN_ID)" -x "*.DS_Store"
	@echo "✅ $(ZIP) created."

# Copy (not symlink) the plugin into UlanziDeck, bundling node_modules — this
# mirrors exactly how the Community Store ZIP is installed (self-contained, no
# dependency on this repo's location or an external volume staying mounted).
install:
	@if [ ! -d "$(PLUGIN_ID)/node_modules" ]; then \
		echo "→ Installing deps..."; \
		cd "$(PLUGIN_ID)" && npm install --omit=dev --silent; \
	fi
	@echo "→ Installing $(PLUGIN_ID) to $(INSTALL_DIR)..."
	@mkdir -p "$(INSTALL_DIR)"
	@rsync -a --delete --exclude=".DS_Store" --exclude="*.log" "$(PLUGIN_ID)/" "$(INSTALL_DIR)/"
	@$(MAKE) restart

restart:
	@echo "→ Restarting $(APP_NAME)..."
	@killall "$(APP_PROC)" 2>/dev/null || true
	@for i in 1 2 3 4 5; do \
		pgrep -x "$(APP_PROC)" >/dev/null 2>&1 || break; \
		sleep 1; \
	done
	@pkill -x "$(APP_PROC)" 2>/dev/null || true
	@sleep 1
	@open -a "$(APP_NAME)" || echo "⚠️ Could not open $(APP_NAME). Please start it manually."

clean:
	@rm -rf $(DIST_DIR)

bump_major bump_minor bump_patch:
	@TYPE=$$(echo $@ | sed s/bump_//); \
	cd $(PLUGIN_ID) && npm version $$TYPE --no-git-tag-version --silent; \
	NEW_VER=$$(node -p "require('./package.json').version"); \
	node -e "\
		const fs = require('fs'); \
		const m = JSON.parse(fs.readFileSync('manifest.json')); \
		m.Version = '$$NEW_VER'; \
		fs.writeFileSync('manifest.json', JSON.stringify(m, null, 2) + '\n'); \
	"; \
	echo "✓ Version bumped to $$NEW_VER (package.json + manifest.json)"
