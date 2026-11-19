.PHONY: run test docker clean

run:
	node server.js

test:
	node --test test/

docker:
	docker compose up --build

clean:
	rm -rf data
