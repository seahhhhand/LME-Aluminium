# LME 알루미늄 대시보드 (웹 버전)

브라우저에서 주소만 열면 누구나 볼 수 있는 대시보드입니다. 데이터 수집은 GitHub가 매일 한국시간 오전 9시부터 자동으로 실행하므로, 내 PC에 아무것도 설치하거나 켜 둘 필요가 없습니다.

```
GitHub Actions (매일 09:00~12:30, 30분 간격)
   └ Westmetall에서 LME 알루미늄 가격·재고 수집 → data/lme.js 갱신
GitHub Pages
   └ index.html이 data/lme.js를 읽어 화면 표시 → https://<아이디>.github.io/<저장소>/
```

## 설정 (처음 한 번, 약 10분)

1. **GitHub 계정 만들기**: github.com에서 가입합니다. 무료 계정이면 충분합니다.
2. **저장소 만들기**: 오른쪽 위 `+` → `New repository`를 누르고, 이름(예: `lme-aluminium`)을 정한 뒤 `Public`을 선택해 만듭니다.
3. **파일 올리기**: 저장소 화면의 `uploading an existing file`을 누르고, 압축을 푼 폴더 안의 내용물을 전부 끌어다 놓은 뒤 `Commit changes`를 누릅니다.
   - `.github` 폴더는 숨김 폴더라 끌어다 놓기에서 빠질 수 있습니다. 빠졌다면 `Add file` → `Create new file`에서 파일 이름에 `.github/workflows/update.yml`을 입력하고, 이 폴더의 같은 파일 내용을 붙여 넣으세요.
4. **자동 수집 권한 주기**: `Settings` → `Actions` → `General`로 가서, 맨 아래 `Workflow permissions`를 `Read and write permissions`로 바꾸고 저장합니다.
5. **웹사이트 켜기**: `Settings` → `Pages`에서 Source를 `Deploy from a branch`로, Branch를 `main` / `/ (root)`로 지정하고 저장합니다.
6. **첫 데이터 받기**: `Actions` 탭에서 `LME 데이터 업데이트` → `Run workflow`를 누릅니다. 1~2분 뒤 초록색 체크가 뜨면 성공입니다.
7. **접속**: `Settings` → `Pages` 상단에 표시되는 주소(`https://<아이디>.github.io/<저장소>/`)를 열면 대시보드가 보입니다. 이 주소를 팀원에게 공유하면 됩니다.

설정 전에 화면 구성을 먼저 보고 싶으면 `index.html`을 더블클릭한 뒤 "샘플 데이터로 미리보기"를 누르세요.

## 동작 방식

- 매일 한국시간 09:00~12:30에 30분 간격으로 확인하고, 새 데이터가 있을 때만 저장합니다. GitHub의 예약 실행은 붐비는 시간에 10~30분 늦어질 수 있어서 여러 번 확인하도록 해 두었습니다.
- 페이지를 열어 두면 30분마다 새 데이터를 자동으로 다시 읽습니다.
- 주말과 영국 공휴일에는 LME 거래가 없어서 데이터가 바뀌지 않는 것이 정상입니다.
- 오른쪽 위 표시등이 주황색이면 5일 넘게 새 데이터가 없다는 뜻입니다. `Actions` 탭에서 실패한 실행(빨간 X)을 눌러 원인을 확인하세요.

## 알아둘 점

- **공개 범위**: Public 저장소의 Pages 주소는 링크를 아는 누구나 볼 수 있습니다. 담기는 내용은 공개 시장 데이터뿐이지만, 저장소에 회사 내부 자료는 올리지 마세요. 비공개로 운영하려면 GitHub 유료 플랜(Pro, Team, Enterprise)이 필요합니다.
- **데이터 성격**: 출처는 Westmetall이 공개하는 LME 알루미늄 공식가격(Cash-Settlement, 3-month)과 LME 재고입니다. 장 마감 종가가 아닌 공식가격이며, 재고는 가격보다 하루 늦게 채워질 수 있습니다. 참고용 자료이므로 계약 단가 산정이나 외부 배포에는 LME 공식 데이터 라이선스를 확인하고, Westmetall 이용약관도 확인하세요.
- **사내 네트워크**: 차트와 글꼴을 cdn.jsdelivr.net에서 불러옵니다. 회사망에서 이 주소가 막혀 있으면 차트가 표시되지 않습니다.
- **장기 미사용**: GitHub는 60일 동안 저장소 활동이 없으면 예약 실행을 멈춥니다. 매일 데이터가 저장되면서 활동으로 잡히기 때문에 보통은 문제없지만, 멈췄다는 안내 메일을 받으면 `Actions` 탭에서 다시 켜 주세요.

## 문제가 생기면

| 증상 | 확인할 것 |
|---|---|
| Actions가 실패하고 "HTTP 403" 등이 보임 | 원본 사이트가 요청을 막은 경우입니다. 잠시 뒤 다시 실행해 보세요. |
| "가격 표를 찾지 못했습니다" | 원본 사이트 구조가 바뀐 경우입니다. `scripts/fetch.mjs`의 `parseHtml`만 고치면 됩니다. |
| 커밋 단계에서 권한 오류 | 설정 4단계(Read and write permissions)를 확인하세요. |
| 페이지가 404 | 설정 5단계 후 1~2분 기다린 뒤 다시 여세요. |

## 파일 구성

| 파일 | 역할 |
|---|---|
| `index.html` | 대시보드 화면 (이 파일 하나로 동작) |
| `data/lme.js`, `data/lme.json` | 수집된 데이터 (자동 생성) |
| `scripts/fetch.mjs` | 데이터 수집 스크립트 (GitHub에서 실행) |
| `.github/workflows/update.yml` | 매일 자동 실행 일정 |
| `tests/parse.test.mjs` | 수집 스크립트 테스트 (`node --test tests/parse.test.mjs`) |
