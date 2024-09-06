## Dump report

```angular2html
cd go/
go test -coverprofile=coverage.out
cd -
# Dump report
GITHUB_REPOSITORY=azu/octocov-viewer octocov dump
```
