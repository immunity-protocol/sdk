# macOS note: default `openssl` is LibreSSL and lacks ed25519 support.
# Use Homebrew's openssl@3:
#   make OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl keys

OPENSSL ?= openssl

.PHONY: keys up down logs clean

keys:
	@mkdir -p keys
	@for name in alice bob; do \
		if [ -f keys/$$name.pem ]; then \
			echo "keys/$$name.pem exists, skipping"; \
		else \
			$(OPENSSL) genpkey -algorithm ed25519 -out keys/$$name.pem && \
			chmod 600 keys/$$name.pem && \
			echo "wrote keys/$$name.pem"; \
		fi; \
	done

up: keys
	docker compose -f compose.yml up -d

down:
	docker compose -f compose.yml down

logs:
	docker compose -f compose.yml logs -f

clean: down
	rm -f keys/*.pem
