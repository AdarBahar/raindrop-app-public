# Local commands for the app. Run `make deploy` in the checkout to update a local service.
# The app runs as the systemd user service raindrop-app.

SERVICE := raindrop-app
BACKEND := app/backend

.PHONY: deploy pull stop migrate start status logs

# Pull, stop the app, run the migrations, start the app again.
# The steps are lines of one recipe, so they run in this order, even with make -j.
# A failed step stops the rest. The app is stopped while migrations run, so no request reads a half-changed schema.
deploy:
	$(MAKE) --no-print-directory pull
	$(MAKE) --no-print-directory stop
	$(MAKE) --no-print-directory migrate
	$(MAKE) --no-print-directory start

# Fast-forward only, so a local commit cannot slip into the deploy.
pull:
	git pull --rebase=merges --ff-only
	cd $(BACKEND) && npm ci --omit=dev

stop:
	systemctl --user stop $(SERVICE)

# Runs as the admin role (DATABASE_ADMIN_URL in .env). Does nothing when no migration is new.
migrate:
	cd $(BACKEND) && npm run migrate

start:
	systemctl --user start $(SERVICE)
	systemctl --user --no-pager status $(SERVICE) | head -5

status:
	systemctl --user --no-pager status $(SERVICE)

logs:
	journalctl --user -u $(SERVICE) -n 100 --no-pager
