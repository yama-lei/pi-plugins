.DEFAULT_GOAL := help

# PACKAGE: all | comma-separated package names (see `make list`)
PACKAGE ?= all
VERSION ?= patch
CONFIRM ?=
export RELEASE_PACKAGE = $(PACKAGE)
export RELEASE_VERSION = $(VERSION)
export RELEASE_CONFIRM = $(CONFIRM)

.PHONY: help list check test verify pack bump publish release install uninstall
help list check test verify pack bump publish release:
	node scripts/release.mjs $@

# Debug: globally install/remove a local package in Pi. Usage: make install|uninstall <name>...
# <name> is a directory under packages/ (see `make list`); the "pi-" prefix is optional.
ifneq ($(filter $(firstword $(MAKECMDGOALS)),install uninstall),)
INSTALL_NAMES := $(patsubst pi-%,%,$(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS)))
$(eval $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS)):;@:)
endif

install:
	@test -n "$(INSTALL_NAMES)" || { echo "用法: make install <name>... (如 make install monitor)"; exit 1; }
	@for n in $(INSTALL_NAMES); do \
		dir="$(CURDIR)/packages/pi-$$n"; \
		test -f "$$dir/package.json" || { echo "未知包: $$n (packages/pi-$$n 不存在)"; exit 1; }; \
		echo "pi install $$dir"; \
		pi install "$$dir" || exit 1; \
	done

uninstall:
	@test -n "$(INSTALL_NAMES)" || { echo "用法: make uninstall <name>... (如 make uninstall monitor)"; exit 1; }
	@for n in $(INSTALL_NAMES); do \
		dir="$(CURDIR)/packages/pi-$$n"; \
		test -f "$$dir/package.json" || { echo "未知包: $$n (packages/pi-$$n 不存在)"; exit 1; }; \
		echo "pi remove $$dir"; \
		pi remove "$$dir" || exit 1; \
	done
