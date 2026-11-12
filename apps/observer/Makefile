# mach-observer, the read-only observer behind the MACH Control Tower (MACH Next M6.1). Standard
# library only. `make build` embeds the Control Tower; `make host` builds with the placeholder page.
.PHONY: build host test vet smoke clean

build:
	./build.sh

host:
	go build -trimpath -o bin/mach-observer ./cmd/mach-observer

vet:
	go vet ./...

test: vet
	go test -race -count=1 ./...

smoke: host
	./smoke.sh bin/mach-observer

clean:
	rm -rf bin
