# mach-studio. `make build` embeds the real web app; `make host` builds with the placeholder page.
.PHONY: build host test vet clean

build:
	./build.sh

host:
	go build -trimpath -o bin/mach-studio ./cmd/mach-studio

vet:
	go vet ./...

test: vet
	go test -count=1 ./...

clean:
	rm -rf bin
