<div align="center">

<img src="docs/screenshots/mark.svg" alt="Ottr" width="140" />

# Ottr

### AI 네이티브 개인 서버 관리자

*서버 사이를 헤엄치다.*

**오픈 소스 · 무료 · macOS / Windows / Linux · 데이터는 언제나 사용자의 것**

[![GitHub](https://img.shields.io/badge/GitHub-huluohu%2FOttr-0F172A)](https://github.com/huluohu/Ottr)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-14B8A6)](#-download--install)
[![License](https://img.shields.io/badge/license-MIT-5EEAD4)](#-license--author)

**언어:** [English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Italiano](README.it.md)

</div>

---

**Ottr**은 가볍고 오픈 소스인 AI SSH 클라이언트입니다 — 설치 용량은 약 8MB(AppImage는 84MB), 상주 메모리는 약 100MB이며, 백그라운드 서비스도 설치해야 하는 에이전트도 없습니다. "서버에 접속해 명령을 입력한다"가 "터미널이 AI를 이해한다"로 바뀝니다. 실패한 명령은 원인을 진단해 주고, 자연어 설명만으로 명령을 생성하며, 명령 기록은 어디서든 검색할 수 있습니다.

이 앱이 절대 타지 않는 원칙이 하나 있습니다. 바로 **AI 키는 사용자가 직접 가져옵니다(BYOK)**는 점입니다. 요청은 사용자의 컴퓨터에서 직접 선택한 모델 엔드포인트로 전달되며, 중간에 Ottr 서버를 거치지 않습니다. 시크릿은 사용자의 컴퓨터에서 저장 시점에 암호화되고, 호스트 메타데이터와 명령 기록은 로컬 SQLite 파일에 보관됩니다. AI 요청과 선택적 동기화에 대한 정확한 데이터 경계는 [개인정보 보호 및 AI](#-privacy--ai-data-boundaries)에 설명되어 있습니다.

![시작 화면: 시간대별 인사말, 빠른 작업, 아이콘 레일](docs/screenshots/home-welcome.png)

## ✨ 무엇을 할 수 있나

### 터미널과 세션

- **탭과 분할 창**(좌우 또는 상하 배치), GPU 가속 렌더링, 검색, URL 감지, 이스케이프 시퀀스 완전 지원
- **자동으로 적응하는 인코딩**: UTF-8 / GBK / GB18030을 자동으로 감지하고 직접 전환할 수 있습니다 — 중국어 Windows 서버에 필수
- **자기 복구 연결**: 백오프를 적용한 자동 재연결, Keepalive를 통한 끊어진 링크 감지, 연결 상태 표시등, 재시작 후 탭 복원
- **세션 녹화**를 [asciinema v2](https://docs.asciinema.org/manual/asciinema-v2/) 형식으로 저장하고, 앱 안에서 타임라인 플레이어(스크럽, 배속 재생)로 재생하며, 공유 가능한 **비식별 처리된 텍스트**로 내보내기

### 호스트와 자격 증명

- 그룹, 태그, 검색, **⌘K 퍼지 빠른 연결**; `~/.ssh/config`, Tabby(JSON/YAML), Xshell 세션, CSV 가져오기·내보내기 지원 — 내보내기에는 호스트 메타데이터만 담기고 시크릿은 절대 포함되지 않습니다
- 자격 증명 볼트: 비밀번호, SSH 키(ed25519/ecdsa/rsa — 생성, 가져오기, 공개 키 배포), TOTP 2단계 인증을 보관하고, 호스트에 연결하면서 **이름을 붙일 수 있어** 하나의 자격 증명으로 여러 호스트를 처리할 수 있습니다
- 시각적으로 정리하는 **점프 호스트 체인**; 로컬·동적 SOCKS·원격 포워딩을 위한 **포트 포워딩**, 연결이 끊어지면 자동으로 다시 설정
- 최초 사용 시 신뢰(TOFU)와 주기적인 지문 점검을 적용하는 known_hosts — 중간자 공격을 잡아냅니다

![다크 테마: 아이콘 레일, 호스트 패널, 떠 있는 탭 아일랜드, 연결 상태 점](docs/screenshots/main-dark.png)

### 데이터를 존중하는 AI

- **실패 시 진단**: 0이 아닌 종료 코드가 나타나면 원인이 될 만한 이유와 제안된 해결책을 보여 줍니다. 확인 없이 아무것도 실행되지 않으며, 위험한 명령은 빨간색으로 표시됩니다
- **⌘J로 명령 생성**: 원하는 작업을 중국어나 영어로 설명하면 현재 디렉터리를 기준으로 한 줄짜리 명령을 돌려줍니다
- **선택해서 설명**: 선택한 텍스트를 우클릭해 설명, 번역, 수정을 요청할 수 있습니다. 세션은 자동 생성된 요약으로 끝낼 수 있고, ⌘R로 검색할 수 있습니다
- **여러 Provider를 아우르는 BYOK**: OpenAI 호환 엔드포인트(**OpenAI / DeepSeek / Zhipu GLM / 사용자가 직접 호스팅한 엔드포인트**), Anthropic Claude, 로컬 Ollama — 프리셋이 엔드포인트를 채워 넣고, 키는 사용자의 컴퓨터에서 암호화됩니다
- **규칙 기반 비식별 처리**: 진단·설명·요약에서 패턴이 일치하는 항목을 자리표시자로 바꿉니다. 모든 시크릿을 빠짐없이 잡아 낼 수는 없습니다. 자연어 명령 입력과 현재 디렉터리 컨텍스트는 **비식별 처리 대상이 아닙니다**. Ottr은 세 플랫폼 모두에서 MCP 서버를 함께 제공하며, Claude Desktop, Cursor 같은 stdio MCP 클라이언트가 통신할 수 있고, 호스트별 권한 부여와 호출별 승인을 지원합니다

### 모니터링, 알림, 운영

- **에이전트 없는 모니터링**: 실시간 CPU / 메모리 / 디스크 / 로드 / 네트워크 차트와 프로세스 브라우저, 다중 호스트 개요
- **알림 규칙**(디스크, CPU, 프로세스, 로그 키워드)을 **12개 알림 채널**로 전달: WeCom, DingTalk, Feishu, Telegram, Slack, Discord, SMTP 이메일 등. 속도 제한, 재시도, 남아 있는 전송 로그 제공
- 네이티브 스케줄러가 실행하는 **예약 작업**(놓친 실행은 사라지지 않고 기록으로 남음), 선택한 호스트 대상 **일괄 실행**과 스니펫 라이브러리, 동시 실행 수와 타임아웃 제어

### 파일과 동기화

- **2분할 SFTP 브라우저**: 드래그 앤 드롭 전송, 병렬 청크, 재개 가능한 업로드; trzsz(trz/tsz) 지원, FTP와 FTPS도 지원
- **원격 편집**을 로컬 편집기에서 하되 원자적 저장을 사용합니다(실패해도 원격 파일이 손상되지 않음). 바이너리 탐지로 실수로 편집하는 일을 막아 줍니다
- **다중 기기 동기화**는 종단 간 암호화 봉투(AES-256-GCM + PBKDF2)를 통해 세 가지 채널 중 하나로 진행 — **WebDAV, Git, 로컬 폴더**(WebDAV는 네이티브 프록시를 통해 사용자의 드라이브로 곧장 연결되며, 교차 출처 제한이 없습니다) — 항목별 푸시/풀과 충돌마다 수동으로 결정

### 직접 검증할 수 있는 보안

- 시크릿과 자격 증명은 **AES-256-GCM**으로 보호됩니다(전체 DB 암호화가 아닙니다). 두 가지 모드가 있습니다. 기본값은 **키체인 모드**(마스터 키가 시스템 키체인에 있어 앱을 열기만 하면 됩니다), 또는 **마스터 비밀번호 모드**(Argon2id 키 유도 — 그 비밀번호 없이는 시크릿 필드를 복호화할 수 없음). 언제든 전환할 수 있고, 전환하면 시크릿을 다시 암호화합니다
- 민감한 사본은 설정된 주기에 따라 알아서 지워지고, 잠금 화면은 "비밀번호를 잊었어요" 초기화를 안내해 줍니다(확인 필요, 클라우드 백업은 그대로 유지)
- Ottr은 **텔레메트리를 보내지 않습니다**. 다만 AI와 동기화 기능은 필요한 데이터를 그대로 전송합니다 — 이것이 "호스트 데이터가 절대로 컴퓨터 밖으로 나가지 않는다"는 뜻은 아닙니다

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/palette.png" alt="커맨드 팔레트"></td>
    <td width="50%"><img src="docs/screenshots/cron.png" alt="예약 작업 센터"></td>
  </tr>
  <tr>
    <td width="50%">⌘K 커맨드 팔레트(퍼지 검색)</td>
    <td width="50%">예약 작업 센터</td>
  </tr>
</table>

<details>
<summary>스크린샷 더 보기</summary>

![다중 호스트 개요](docs/screenshots/overview.png)
![자격 증명 관리자](docs/screenshots/credentials.png)

</details>

## 📦 다운로드 및 설치 <a id="-download--install"></a>

[**Releases**](https://github.com/huluohu/Ottr/releases)에서 사용할 플랫폼에 맞는 빌드를 받아 보세요:

| 플랫폼 | 형식 |
|---|---|
| macOS (Apple Silicon) | `.dmg` |
| macOS (Intel) | `.dmg` |
| Windows | `.msi` / `.exe` 인스톨러, 또는 **`_x64_portable.zip`(설치 불필요)** |
| Linux | `.deb` / `.rpm` / `.AppImage` |

최초 실행 시 Ottr은 이 컴퓨터에서 시크릿 필드를 어떤 방식으로 암호화할지 묻습니다(전체 DB가 아니라 시크릿 필드만). **키체인 모드**(기억할 비밀번호 없음) 또는 **마스터 비밀번호 모드**(그것 없이는 시크릿 필드를 복호화할 수 없음) 중 하나를 고르면 됩니다.

**Windows 포터블 빌드**: 원하는 곳에 압축을 풀고 `Ottr.exe`를 실행하세요 — 아무것도 설치되지 않고, 설정과 데이터는 앱 옆의 `Ottr/data/`에 저장됩니다(폴더를 복사하면 환경을 옮기고, 삭제하면 제거됩니다. WebView2가 필요하지만 Win10/11에는 기본으로 포함되어 있습니다). 포터블 빌드는 스스로 업데이트할 수 없습니다 — 새 zip을 받아 기존 파일을 덮어쓰되, `data/`만 그대로 두면 모든 설정이 유지됩니다.

설치된 빌드에는 **앱 내 업데이트**가 있습니다(Settings → About, 서명된 패키지만 해당), 언제든 이 페이지로 돌아와 직접 다운로드할 수도 있습니다.

<details>
<summary><strong>🍎 macOS가 "손상된 앱"이라 하거나 LAN에 접근하지 못하나요? 해결 방법을 여세요</strong></summary>

Ottr은 아직 Apple Developer ID로 서명되어 있지 않아 macOS가 평소보다 엄격하게 처리합니다 — **다운로드가 손상된 것은 아닙니다**. 두 단계만 거치면 끝입니다.

**1️⃣ "Ottr은 손상되어 열 수 없습니다. 휴지통으로 옮기십시오."**

터미널을 열고 다음 명령을 한 번 실행한 뒤 Ottr을 평소처럼 여세요(업데이트할 때마다 반복):

```bash
xattr -cr /Applications/Ottr.app
```

**2️⃣ LAN에 있는 컴퓨터에 연결할 때 "No route to host" 오류**

macOS 15부터는 앱이 네트워크에 있는 장치에 닿으려면 "Local Network"(로컬 네트워크) 권한을 먼저 허용해야 합니다. 권한 요청 창이 보이면 **Allow**를 클릭하세요. 창이 전혀 나타나지 않는데 연결이 실패한다면 둘 중 하나를 고르세요:

- **터미널에서 Ottr 실행**(이렇게 실행한 앱은 해당 제한의 영향을 받지 않습니다):

  ```bash
  /Applications/Ottr.app/Contents/MacOS/ottr &
  ```

- **LAN 대역을 한 번에 허용**(관리자 비밀번호를 요구합니다. `192.168.9.0/24`를 사용자의 대역으로 바꾼 뒤 재시작하세요):

  ```bash
  sudo defaults write com.apple.network.local-network AllowedWiFiLocalNetworkAddresses -array "192.168.9.0/24"
  sudo defaults write com.apple.network.local-network AllowedEthernetLocalNetworkAddresses -array "192.168.9.0/24"
  ```

  나중에 시스템 기본값으로 되돌리려면 아래 명령을 실행하고 한 번 더 재시작하세요:

  ```bash
  sudo defaults delete com.apple.network.local-network AllowedWiFiLocalNetworkAddresses
  sudo defaults delete com.apple.network.local-network AllowedEthernetLocalNetworkAddresses
  ```

Ottr이 정상적인 Apple Developer ID 서명으로 배포되면 이 작업은 전혀 필요 없어집니다.

</details>

## 🚀 빠른 시작

1. **호스트 추가**: 사이드바의 "New host"(그룹 헤더에 마우스를 올려 **＋**를 누르면 그 그룹에 바로 추가) 또는 "Import ssh config"; 호스트 행을 더블클릭하면 연결됩니다 — 지문은 첫 접속 때 표시되며, 신뢰한 뒤로는 다시 묻지 않습니다
2. **AI 켜기**: Settings → AI → Provider 추가(Zhipu GLM, DeepSeek, Ollama 같은 프리셋을 고르고 키를 붙여넣기). 그다음부터 실패한 명령은 자동으로 진단되고, **⌘J**가 자연어 요청을 명령으로 바꿔 줍니다
3. **알림 설정**: Settings → Alerts → 알림 채널 추가(테스트 메시지를 보내 확인) → "root partition > 90%" 같은 규칙 만들기. 같은 페이지의 "notification types" 항목이 어떤 이벤트를 알릴지 결정합니다
4. **기기 간 동기화**: 두 번째 기기에 Ottr을 설치하고, Settings → Sync에서 채널을 고릅니다(WebDAV는 드라이브 URL 입력), 동기화 패스프레이즈를 설정한 뒤 **Sync now**를 누릅니다
5. **더 나아가기**: **⌘R**은 기록 검색, **⌘D**(Windows/Linux에서는 Ctrl+⇧D)는 창 분할, "File" 메뉴(macOS)는 호스트 가져오기·내보내기, "Tools" 메뉴(macOS) 또는 **⌘K** 팔레트에서 포트 포워딩, 점프 호스트 체인, 예약 작업, 일괄 실행, 알림 센터로 갈 수 있습니다(읽지 않은 개수는 아이콘 레일과 메뉴에 그대로 표시됩니다)

## 🔐 개인정보 보호 및 AI 데이터 경계 <a id="-privacy--ai-data-boundaries"></a>

- **로컬 저장**: SSH 비밀번호, 개인 키, 키 패스프레이즈, AI API 키는 AES-256-GCM으로 필드별 암호화됩니다. 호스트 주소, 사용자 이름, 메모, 명령 기록, 일반 설정은 로컬 SQLite 파일에 평문으로 남습니다 — 볼트를 잠그거나 마스터 비밀번호를 설정해도 이 항목들은 암호화되지 않습니다. 동기화는 별도의 암호화 봉투를 쓰며 로컬 DB의 저장 방식은 바뀌지 않습니다
- **진단과 설명**: 진단은 실패한 명령과 터미널 출력의 끝부분(최대 8KB)을 전송하고, 설명은 선택한 텍스트를 전송합니다. 전송 전에 규칙이 IP 주소, 비밀번호 대입, 이메일 주소, 그리고 활성화된 경우 호스트 이름과 사용자 지정 패턴을 치환합니다. 요약에도 비슷한 규칙이 명령 나열에 적용됩니다. 규칙은 샘플과 다르게 생겼거나 내부 이름·업무 데이터인 시크릿을 놓칠 수 있습니다. "N개 항목 비식별 처리됨"은 일치한 개수를 센 것이지 완전성을 보장하지 않습니다. 패널에는 로컬에서 원본 텍스트가 그대로 보일 수 있습니다
- **자연어로 명령 생성**: 요청 내용과 현재 디렉터리(OSC 7)가 컨텍스트로 선택한 모델 엔드포인트에 전송되며, 위의 비식별 처리는 적용되지 않습니다. 비밀번호, 토큰, 전송되면 곤란한 내용은 입력하지 마세요. 직접 연결하더라도 Provider가 내용을 받거나 보관하지 않는다는 보장은 없습니다 — 이는 Provider의 몫입니다
- **Ollama**: 프리셋 엔드포인트는 `http://localhost:11434/v1`입니다. 엔드포인트와 추론이 모두 이 컴퓨터에 남아 있는 동안에만 처리가 로컬로 이루어집니다. 원격 주소나 프록시, 클라우드 모델을 가리키게 되면 내용이 로컬에 머문다는 것은 더 이상 약속할 수 없습니다
- **AI 명령 삽입**: 줄바꿈과 제어 문자가 없는 한 줄 텍스트만 받아들이며, 캐리지 리턴도 덧붙이지 않습니다. 여러 줄 콘텐츠는 그대로 두고 삽입은 비활성화합니다 — 직접 검토하고 명령을 준비하세요. 임의로 이어 붙이거나 첫 줄로 잘라내지 않습니다. 위험도 등급은 힌트일 뿐 명령이 안전하다는 증거는 아닙니다. 삽입 전에 터미널이 기대한 상태인지, 이미 입력된 내용이 무엇인지 확인하세요. 사용자 정의 키 바인딩과 대화형 프로그램은 이 보장의 범위에 들어 있지 않습니다

## 📄 라이선스 및 작성자 <a id="-license--author"></a>

**Ottr**은 [@huluohu](https://github.com/huluohu)가 개발하며 [MIT](LICENSE-MIT) 라이선스로 배포됩니다 — 이슈와 풀 리퀘스트를 환영합니다. 저장소: [github.com/huluohu/Ottr](https://github.com/huluohu/Ottr).

<div align="center">

*서버 사이를 헤엄치다.* 🦦

</div>
