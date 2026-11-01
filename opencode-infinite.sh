#!/usr/bin/env bash
# OpenCode Infinite for Linux: the Windows launcher's flow in bash.
# Egress WARP / TOR / PROXY / NONE, target IP hunt, probe, resume when a limit stops the chat.
# Needs: bash 4.3+, curl, node + opencode. Optional: warp-cli, tor, privoxy, jq (menus in other languages).
VERSION="linux-0.3.0"
REPO="https://gitlab.com/jekooo/opencode-infinite"
REPO_RAW="https://gitlab.com/jekooo/opencode-infinite/-/raw/main"

STATE_DIR="${OCI_STATE:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode-infinite}"
CONF="$STATE_DIR/config.env"
LOG="$STATE_DIR/launcher.log"
APP_DIR="$STATE_DIR/app"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
BIN_DIR="$HOME/.local/bin"
LIMIT_FLAG="$STATE_DIR/limit.flag"
SELF="$(readlink -f "$0")"
ARGS=("$@")
OC_PAT='level=ERROR.*(Failed to drain Session|free usage limit|usage limit reached|rate limit|out of usage|insufficient credits|payment required)'
ESC=$'\e'
PATH="$PATH:/usr/sbin:/sbin"  # tor and privoxy live here on Debian and Ubuntu
MARG=""
mkdir -p "$STATE_DIR"

# ---------------------------------------------------------------- settings table
# key|group|type|default|label|help|options: enum a,b / num min:max / bool and text leave it empty
SETDEF=(
'OC_EGRESS_DEFAULT|Connection|enum|ASK|Egress|ASK = pick at each start. WARP, TOR, PROXY or NONE = used for OpenCode. System traffic stays direct.|ASK,WARP,TOR,PROXY,NONE'
'PROXY_PORT|Connection|num|40000|WARP proxy port|Local port of the WARP proxy.|1:65535'
'WARP_WAIT|Connection|num|20|WARP wait (s)|Seconds to wait after (re)connecting WARP.|1:120'
'WARP_CALL_TIMEOUT|Connection|num|15|warp-cli timeout (s)|Seconds a single warp-cli call may take.|5:300'
'TOR_SOCKS_PORT|Tor|num|9050|Tor SOCKS port|SOCKS port of the Tor the launcher starts. A Tor already on this port is reused.|1:65535'
'TOR_HTTP_PORT|Tor|num|8118|Tor HTTP bridge port|HTTP port of the built-in bridge OpenCode uses. Must be free or already a Tor bridge.|1:65535'
'TOR_AUTO_INSTALL|Tor|bool|1|Install Tor automatically|Install tor and privoxy with the package manager when they are missing.|'
'TOR_BOOTSTRAP_WAIT|Tor|num|120|Tor bootstrap wait (s)|Seconds to wait for Tor to finish bootstrapping.|30:900'
'PROXY_LIST_URL|Proxy list|text|https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=protocolipport&format=text|Proxy list source|URL or local file, any format. ip:port entries are picked out of it. Type - to clear.|'
'PROXY_LIST_MIN_BYTES|Proxy list|num|20|Minimum list size (bytes)|A downloaded list smaller than this is rejected. 0 = off.|0:100000000'
'PROXY_TRY_MAX|Proxy list|num|25|Proxies tried per pick|How many proxies to test before giving up.|1:500'
'PROXY_PROBE_TIMEOUT|Proxy list|num|8|Proxy test timeout (s)|Seconds a single proxy test may take.|1:120'
'PROXY_ROT_MAX|Proxy list|num|10|Burned proxies before Tor offer|Burned proxies in one hunt before PROXY mode offers Tor.|1:200'
'PROXY_API_CHECK|Proxy list|bool|0|Check the API host|A proxy must also reach the OpenCode API host.|'
'PROXY_API_CHECK_URL|Proxy list|text|https://api.opencode.ai/|API check URL|Host used by the API check. Type - to clear.|'
'AUTO_ROTATE|Rotation|bool|1|Automatic rotation|On: a limit or a closed OpenCode gets a new IP and the chat resumes. Off: the menu decides.|'
'ROTATE_TRIES_MAX|Rotation|num|4|Rotation attempts|Attempts per round when the route is not up.|1:20'
'ROTATE_COOLDOWN|Rotation|num|10|Cooldown between attempts (s)|Seconds to wait between rotation tries. Cloudflare throttles rapid registrations.|0:300'
'IP_FIND_MAX|Rotation|num|0|Burned IPs allowed|IPs the probe may reject before giving up. 0 = no limit.|0:10000'
'TARGET_COUNTRY|Rotation|text||Target country|Keep asking for IPs until one is in this country, e.g. DE. Empty = any. Type - to clear.|'
'TARGET_PREFIX|Rotation|text||Target IP prefix|Keep asking until the IP starts with this, e.g. 104.28. Empty = not used. Type - to clear.|'
'TARGET_TRIES|Rotation|num|1|Max attempts per hunt|New IPs requested in one hunt. The hunt stops at this count.|1:100'
'TARGET_MINUTES|Rotation|num|15|Max minutes per hunt|The hunt stops after this many minutes.|1:240'
'TARGET_INTERVAL|Rotation|num|15|Seconds between attempts|Pause between two attempts, so Cloudflare is not hit too fast.|0:300'
'ON_CLOSE|Rotation|enum|ask|After OpenCode closes|ask = R, M or Q: R new IP and resume the chat, M menu, Q quit. quit = leave the launcher at once.|ask,quit'
'WATCH|Watcher|bool|1|Watch the log|Rotate when a fatal error appears while OpenCode runs.|'
'RESUME_MSG|Watcher|text|continue|Resume message|Sent automatically after a rotation.|'
'RESUME_AUTO|Watcher|bool|1|Unattended resume|The resume auto-approves tool permissions (opencode run --auto).|'
'RESUME_TIMEOUT|Watcher|num|90|Resume timeout (s)|Seconds before a silent resume counts as a dead IP.|10:900'
'PROBE|Probe|bool|1|Test every new IP|Send one cheap message through each candidate IP.|'
'PROBE_MODEL|Probe|text|opencode/big-pickle|Probe model|Model used by the IP probe.|'
'PROBE_BROKEN_MAX|Probe|num|3|Probe failures tolerated|Non-limit probe failures before the hunt stops and says the probe is broken.|1:50'
'UPDATE_CHECK|Updates|bool|1|Launcher self-update|Check GitHub for a newer launcher at every start.|'
'UPDATE_ASK|Updates|enum|ask|Update prompts|ask = offer newer versions at start. never = no checks and no prompts.|ask,never'
'OC_API_BASE|Updates|text|https://opencode.ai/update/api/latest|Release metadata URL|Where the newest opencode version is read from. npm is the fallback.|'
'OCUI_THEME|Appearance|enum|ocean|Color theme|Accent colors of the menus.|ocean,forest,sunset,mono,rainbow'
'OCUI_COLOR|Appearance|enum|auto|Colors|auto follows the terminal and NO_COLOR. on or off forces it.|auto,on,off'
'OCUI_ICONS|Appearance|enum|auto|Borders|auto = UTF-8 borders when the locale is UTF-8. unicode or emoji = UTF-8 borders. ascii = plain.|auto,emoji,unicode,ascii'
'OCUI_LANG|Appearance|enum|auto|Language|Language of the menus. auto follows LANG. Only the chosen file is downloaded.|auto,en,de,es,fr,it,pt,tr'
'KEY_ROTATE|Shortcuts|key|R|Rotate key|Closed-OpenCode prompt: new IP and resume the chat. One letter.|'
'KEY_MENU|Shortcuts|key|M|Menu key|Closed-OpenCode prompt: open the menu. One letter.|'
'KEY_QUIT|Shortcuts|key|Q|Quit key|Closed-OpenCode prompt: quit. Ctrl+C always quits too. One letter.|'
'LOG_ENABLED|Logs|bool|1|Activity log|Record what the launcher does in launcher.log.|'
'LOG_MAX_KB|Logs|num|1024|Log size limit (KB)|The log is cut to its newest part when it grows past this.|64:10240'
'LOG_MASK_IP|Logs|bool|1|Hide IPs in reports|Public IP addresses are masked in the support report.|'
)
SK=(); SG=(); ST=(); SD=(); SL=(); SH=(); SO=()
for row in "${SETDEF[@]}"; do
  IFS='|' read -r k g t d l h o <<< "$row"
  SK+=("$k"); SG+=("$g"); ST+=("$t"); SD+=("$d"); SL+=("$l"); SH+=("$h"); SO+=("${o:-}")
done

# ---------------------------------------------------------------- config and log
cfg_get(){ local v; v=$(sed -n "s/^$1=//p" "$CONF" 2>/dev/null | tail -n1); printf '%s' "${v:-$2}"; }
cfg_set(){ touch "$CONF"; { grep -v "^$1=" "$CONF"; printf '%s=%s\n' "$1" "$2"; } > "$CONF.tmp" && mv "$CONF.tmp" "$CONF"; }
load_cfg(){
  local i k v
  for i in "${!SK[@]}"; do
    k=${SK[i]}; v=$(cfg_get "$k" "${SD[i]}")
    if [ "${ST[i]}" = num ] || [ "${ST[i]}" = bool ]; then [[ "$v" =~ ^[0-9]+$ ]] || v=${SD[i]}; fi
    printf -v "$k" '%s' "$v"
  done
  OC_REAL=$(cfg_get OC_REAL ""); OC_LINK=$(cfg_get OC_LINK ""); SETUP_DONE=$(cfg_get SETUP_DONE 0)
  # EGRESS is the route in use this run: the saved default, or NONE while the default is ASK (picked at start)
  OC_EGRESS_DEFAULT=$(cfg_get OC_EGRESS_DEFAULT "$(cfg_get EGRESS ASK)")
  case $OC_EGRESS_DEFAULT in ASK|WARP|TOR|PROXY|NONE) ;; *) OC_EGRESS_DEFAULT=ASK;; esac
  EGRESS=$OC_EGRESS_DEFAULT; [ "$EGRESS" = ASK ] && EGRESS=NONE
  # keys renamed in 0.3.0: an older config.env keeps its values
  ROTATE_TRIES_MAX=$(cfg_get ROTATE_TRIES_MAX "$(cfg_get ROTATE_TRIES "$ROTATE_TRIES_MAX")")
  [[ $ROTATE_TRIES_MAX =~ ^[0-9]+$ ]] || ROTATE_TRIES_MAX=4
  OCUI_THEME=$(cfg_get OCUI_THEME "$(cfg_get THEME "$OCUI_THEME")")
}
log(){
  [ "$LOG_ENABLED" = 1 ] || return 0
  printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG"
  if [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt $(( LOG_MAX_KB * 1024 )) ]; then tail -c $(( LOG_MAX_KB * 512 )) "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
}

# ---------------------------------------------------------------- language
declare -A TH TRMAP
# tx <english>: the translated label, English when the language file has no entry
tx(){ printf '%s' "${TRMAP[$1]:-$1}"; }
load_lang(){
  TRMAP=()
  local code=$OCUI_LANG
  if [ "$code" = auto ]; then code=${LC_ALL:-${LANG:-en}}; code=${code%%[_.@]*}; fi
  case $code in de|es|fr|it|pt|tr) ;; *) return 0;; esac
  command -v jq >/dev/null || { log 'jq missing: menus stay in English'; return 0; }
  local f="$STATE_DIR/langs/$code.json" k v
  if [ ! -s "$f" ]; then
    mkdir -p "$STATE_DIR/langs"
    curl -fsSL -m 20 "$REPO_RAW/langs/$code.json" -o "$f.tmp" 2>/dev/null && [ "$(stat -c%s "$f.tmp")" -gt 1000 ] && mv "$f.tmp" "$f"
    rm -f "$f.tmp"
  fi
  [ -s "$f" ] || return 0
  while IFS=$'\t' read -r k v; do TRMAP["$k"]=$v; done < <(jq -r 'to_entries[] | [.key, .value] | @tsv' "$f" 2>/dev/null)
}

# ---------------------------------------------------------------- theme and drawing
set_theme(){
  OCUI_THEME=$1
  case $OCUI_THEME in
    forest)  TH=([title]='1;92' [acc]='32' [border]='32' [sel]='30;42' [panel]='' [warn]='33' [ok]='32' [err]='31' [dim]='90');;
    sunset)  TH=([title]='1;95' [acc]='35' [border]='35' [sel]='30;45' [panel]='' [warn]='33' [ok]='32' [err]='31' [dim]='90');;
    mono)    TH=([title]='1' [acc]='0' [border]='0' [sel]='7' [panel]='' [warn]='0' [ok]='0' [err]='0' [dim]='2');;
    rainbow) TH=([title]='rain' [acc]='rain' [border]='rain' [sel]='' [panel]='' [warn]='33' [ok]='32' [err]='31' [dim]='90');;
    *)       OCUI_THEME=ocean; TH=([title]='1;96' [acc]='36' [border]='34' [sel]='30;46' [panel]='' [warn]='33' [ok]='32' [err]='31' [dim]='90');;
  esac
  RAIN=0; [ "$OCUI_THEME" = rainbow ] && RAIN=1
  COLOR=1; [ -n "${NO_COLOR:-}" ] && COLOR=0
  case $OCUI_COLOR in on) COLOR=1;; off) COLOR=0;; esac
  if [ "$OCUI_ICONS" = ascii ] || { [ "$OCUI_ICONS" = auto ] && [[ "${LC_ALL:-${LANG:-}}" != *UTF-8* && "${LC_ALL:-${LANG:-}}" != *utf8* ]]; }; then
    BOX_TL='+' BOX_TR='+' BOX_BL='+' BOX_BR='+' BOX_H='-' BOX_V='|'
  else
    BOX_TL='╭' BOX_TR='╮' BOX_BL='╰' BOX_BR='╯' BOX_H='─' BOX_V='│'
  fi
}
# hue 0-359 to RGB="r;g;b", one step of the rainbow
hue_rgb(){
  local h=$(( ($1 % 360 + 360) % 360 )) s f q
  s=$(( h / 60 )); f=$(( 255 * (h % 60) / 60 )); q=$(( 255 - f ))
  case $s in
    0) RGB="255;$f;0";; 1) RGB="$q;255;0";; 2) RGB="0;255;$f";;
    3) RGB="0;$q;255";; 4) RGB="$f;0;255";; *) RGB="255;0;$q";;
  esac
}
# code_of <name>: sets CODE to the SGR code of a theme slot (no subshell: this runs every frame)
code_of(){
  case $1 in
    sel) if [ "$RAIN" = 1 ]; then hue_rgb $(( RAIN_PH * 8 + 180 )); CODE="30;48;2;$RGB"; else CODE=${TH[sel]}; fi;;
    border) if [ "$RAIN" = 1 ]; then hue_rgb $(( RAIN_PH * 8 )); CODE="38;2;$RGB"; else CODE=${TH[border]}; fi;;
    *) CODE=${TH[$1]};;
  esac
}
# rep <char> <count>: sets REP to the char repeated
rep(){ printf -v REP '%*s' "$2" ''; REP=${REP// /$1}; }
FRAME=""; RAIN_PH=0
# pt <code> <text>: appends colored text to FRAME. code "rain" colors each letter on its own hue
pt(){
  if [ "$COLOR" != 1 ] || [ -z "$1" ]; then FRAME+="$2"; return; fi
  if [ "$1" != rain ]; then FRAME+="${ESC}[$1m$2${ESC}[0m"; return; fi
  local s=$2 i=0 k ch out=""
  for ((k = 0; k < ${#s}; k++)); do
    ch=${s:k:1}
    if [ "$ch" = " " ]; then out+=" "; continue; fi
    hue_rgb $(( RAIN_PH * 8 + i * 28 )); out+="${ESC}[38;2;${RGB}m$ch"; i=$(( i + 1 ))
  done
  FRAME+="$out${ESC}[0m"
}
eol(){ FRAME+="${ESC}[K"$'\n'; }
margin(){ FRAME+="$MARG"; }
banner(){
  local art=(
    ' ___   ____   _____  _   _   ____  ___   ____   _____   '
    '/ _ \ |  _ \ | ____|| \ | | / ___|/ _ \ |  _ \ | ____|  '
    '| | | || |_) ||  _|  |  \| || |    | | | || | | ||  _|  '
    '| |_| ||  __/ | |___ | |\  || |___ | |_| || |_| || |___ '
    ' \___/ |_|    |_____||_| \_| \____| \___/ |____/ |_____|'
    ' ___  _   _  _____  ___  _   _  ___  _____  _____       '
    '|_ _|| \ | ||  ___||_ _|| \ | ||_ _||_   _|| ____|      '
    ' | | |  \| || |_    | | |  \| | | |   | |  |  _|        '
    ' | | | |\  ||  _|   | | | |\  | | |   | |  | |___       '
    '|___||_| \_||_|    |___||_| \_||___|  |_|  |_____|      ')
  local r c
  for r in "${!art[@]}"; do
    margin
    if [ "$RAIN" = 1 ]; then c=rain; elif [ "$r" -lt 5 ]; then c=${TH[title]}; else c=${TH[acc]}; fi
    pt "$c" "${art[r]}"; eol
  done
  margin; pt "${TH[acc]}" "$REPO"; eol; margin; eol
}
# boxline <code> <text>: | text |, the text is padded to the inner width
boxline(){
  local inner=$(( W - 4 )) text=$2; text=${text:0:inner}
  code_of border; local bc=$CODE
  margin; pt "$bc" "$BOX_V "; pt "$1" "$(printf '%-*s' "$inner" "$text")"; pt "$bc" " $BOX_V"; eol
}
boxtop(){
  local t=" $1 " fill
  fill=$(( W - 3 - ${#t} )); rep "$BOX_H" "$fill"
  code_of border; local bc=$CODE; code_of title; local tc=$CODE
  margin; pt "$bc" "$BOX_TL$BOX_H"; pt "$tc" "$t"; pt "$bc" "$REP$BOX_TR"; eol
}
boxbot(){ rep "$BOX_H" $(( W - 2 )); code_of border; margin; pt "$CODE" "$BOX_BL$REP$BOX_BR"; eol; }

# menu state: ML labels, MV values, MH help, MD disabled flags, MVS value colour slots; HEAD lines as "code|text"
reset_items(){ ML=(); MV=(); MH=(); MD=(); MVS=(); HEAD=(); }
item(){ ML+=("$1"); MV+=("${2:-}"); MH+=("${3:-}"); MD+=("${4:-}"); MVS+=("${5:-acc}"); }
draw(){
  local title=$1 foot=$2 n=${#ML[@]} i lab val gap room help
  FRAME=""
  COLUMNS=${COLUMNS:-80}
  W=$(( COLUMNS - 2 )); (( W > 74 )) && W=74; (( W < 56 )) && W=56
  local M=$(( (COLUMNS - W) / 2 )); (( M < 0 )) && M=0
  printf -v MARG '%*s' "$M" ''
  [ "$SHOW_BANNER" = 1 ] && banner
  local h
  for h in "${HEAD[@]}"; do margin; pt "${h%%|*}" "${h#*|}"; eol; done
  [ ${#HEAD[@]} -gt 0 ] && { margin; eol; }
  boxtop "$title"
  for ((i = 0; i < n; i++)); do
    lab="${ML[i]}"; val="${MV[i]}"
    room=$(( W - 10 - ${#lab} )); (( room < 4 )) && room=4
    [ ${#val} -gt "$room" ] && val="${val:0:$(( room - 2 ))}.."
    gap=$(( W - 9 - ${#lab} - ${#val} )); (( gap < 1 )) && gap=1
    printf -v gap '%*s' "$gap" ''
    if [ "$i" -eq "$SEL" ]; then
      code_of sel; local sc=$CODE
      code_of border; local bc=$CODE
      margin; pt "$bc" "$BOX_V "; pt "$sc" "> $(( i + 1 )). $lab$gap$val"; pt "$bc" " $BOX_V"; eol
    else
      code_of border; local bc=$CODE
      local dc=""; [ -n "${MD[i]}" ] && dc=${TH[dim]}
      code_of "${MVS[i]}"; local vc=$CODE
      margin; pt "$bc" "$BOX_V   "; pt "$dc" "$(( i + 1 )). $lab"; pt "" "$gap"; pt "$vc" "$val"; pt "$bc" " $BOX_V"; eol
    fi
  done
  boxbot
  help="${MH[SEL]}"
  if [ -n "${MV[SEL]}" ] && [ ${#MV[SEL]} -gt $(( W - 4 )) ]; then help="Value: ${MV[SEL]}  $help"; fi
  local lines=() ww=$(( W - 4 )) cur="" word q
  for word in $help; do
    if [ -z "$cur" ]; then cur=$word; elif [ $(( ${#cur} + 1 + ${#word} )) -le "$ww" ]; then cur+=" $word"; else lines+=("$cur"); cur=$word; fi
  done
  [ -n "$cur" ] && lines+=("$cur")
  for ((q = 0; q < 3; q++)); do
    margin
    if [ "$q" -lt ${#lines[@]} ]; then
      if [ "$q" -eq 0 ]; then pt "${TH[acc]}" "i ${lines[q]}"; else pt "${TH[acc]}" "  ${lines[q]}"; fi
    fi
    eol
  done
  margin; pt "${TH[dim]}" "arrows move   Enter select   Esc back   1-9 jump"; eol
  if [ -n "$foot" ]; then margin; pt "${TH[dim]}" "$foot"; eol; fi
  printf '\e[H%s\e[J' "$FRAME"
}
# getkey <seconds>: sets KEY. Returns 1 on timeout (KEY=__timeout).
getkey(){
  KEY=""
  if ! IFS= read -rsn1 -t "$1" KEY; then KEY=__timeout; return 1; fi
  if [ "$KEY" = "$ESC" ]; then
    local r=""; IFS= read -rsn2 -t 0.03 r
    case $r in '[A'|'OA') KEY=Up;; '[B'|'OB') KEY=Down;; '[H'|'OH') KEY=Home;; '[F'|'OF') KEY=End;; '') KEY=Esc;; *) KEY=Other;; esac
  elif [ -z "$KEY" ]; then KEY=Enter
  elif [ "$KEY" = $'\x7f' ]; then KEY=Esc
  fi
  return 0
}
# menu <title> [footer]: draws the items and returns the chosen index in MRES (-1 on Esc)
menu(){
  local title=$1 foot=${2:-} n=${#ML[@]} idx
  while :; do
    draw "$title" "$foot"
    if [ "$RAIN" = 1 ]; then
      if ! getkey 0.09; then RAIN_PH=$(( RAIN_PH + 1 )); continue; fi
    else
      getkey 3600 || continue
    fi
    case $KEY in
      Up) SEL=$(( (SEL - 1 + n) % n ));;
      Down) SEL=$(( (SEL + 1) % n ));;
      Home) SEL=0;;
      End) SEL=$(( n - 1 ));;
      Enter) if [ -z "${MD[SEL]}" ]; then MRES=$SEL; return 0; fi;;
      Esc) MRES=-1; return 0;;
      [1-9]) idx=$(( KEY - 1 )); if [ "$idx" -lt "$n" ] && [ -z "${MD[idx]}" ]; then MRES=$idx; return 0; fi;;
    esac
  done
}
# ask <prompt> <default>: reads one line, empty keeps the default. Sets ANSWER.
ask(){
  printf '\e[H\e[J%s\n%s%s%s [%s]: ' "" "$MARG" "${ESC}[${TH[acc]}m" "$1" "$2${ESC}[0m"
  stty echo icanon 2>/dev/null
  IFS= read -r ANSWER || { stty -echo -icanon 2>/dev/null; return 1; }
  stty -echo -icanon 2>/dev/null
  [ -z "$ANSWER" ] && ANSWER=$2
  return 0
}
say(){ local kind=$1; shift; printf '\n%s%s%s%s\n' "$MARG" "${ESC}[${TH[$kind]}m" "$*" "${ESC}[0m"; }
pause(){ printf '\n%sPress any key to continue...' "$MARG"; IFS= read -rsn1 _; }
# confirm <question>: 0 when the user picks Yes
confirm(){
  reset_items; HEAD=("${TH[warn]}|$1" ""); SHOW_BANNER=0
  item "$(tx 'No, cancel')" '' 'Go back. Nothing is changed.'
  item "$(tx 'Yes, continue')" '' 'Do it now.' '' warn
  SEL=0; menu 'Confirm'
  [ "$MRES" = 1 ]
}
# with_tty <cmd...>: runs a command that may ask for a password, with a normal terminal
with_tty(){ stty sane 2>/dev/null; "$@"; local rc=$?; stty -echo -icanon 2>/dev/null; return $rc; }
desk_dir(){ local d; d=$(xdg-user-dir DESKTOP 2>/dev/null) || true; [ -n "$d" ] || d="$HOME/Desktop"; mkdir -p "$d"; printf '%s' "$d"; }

# ---------------------------------------------------------------- settings helpers
show_val(){
  local k=${SK[$1]} v; v=${!k}
  case ${ST[$1]} in
    bool) [ "$v" = 1 ] && echo on || echo off;;
    *) [ -n "$v" ] && echo "$v" || echo "(empty)";;
  esac
}
# valid_val <index> <value>: 0 when the value fits that setting
valid_val(){
  local i=$1 v=$2 o lo hi x
  case ${ST[i]} in
    bool) [[ $v == 0 || $v == 1 ]];;
    num) IFS=: read -r lo hi <<< "${SO[i]}"; [[ $v =~ ^[0-9]+$ ]] && [ "$v" -ge "$lo" ] && [ "$v" -le "$hi" ];;
    enum) IFS=, read -ra o <<< "${SO[i]}"; for x in "${o[@]}"; do [ "$x" = "$v" ] && return 0; done; return 1;;
    key) [[ $v =~ ^[A-Za-z]$ ]];;
    *) [ "${SK[i]}" != TARGET_COUNTRY ] || [ -z "$v" ] || [[ $v =~ ^[A-Za-z]{2}$ ]];;
  esac
}
edit_setting(){ # bool toggles, enum cycles, num and text are asked
  local i=$1 k=${SK[$1]} v o j n nx=0
  v=${!k}
  case ${ST[i]} in
    bool) cfg_set "$k" $(( 1 - v ));;
    enum) IFS=, read -ra o <<< "${SO[i]}"; n=${#o[@]}
          for ((j = 0; j < n; j++)); do [ "${o[j]}" = "$v" ] && nx=$(( (j + 1) % n )); done
          cfg_set "$k" "${o[nx]}";;
    *) ask "$(tx "${SL[i]}")" "$v" || return 0
       [ "$ANSWER" = - ] && ANSWER=""
       [ "$k" = TARGET_COUNTRY ] && ANSWER=${ANSWER^^}
       if valid_val "$i" "$ANSWER"; then cfg_set "$k" "$ANSWER"; else say err "not allowed: ${SO[i]:-two letters or empty}"; pause; fi;;
  esac
}
group_menu(){ # the settings of one group; Enter edits the chosen one
  local g=$1 i n idx
  while :; do
    reset_items; HEAD=(); SHOW_BANNER=0; idx=()
    for i in "${!SK[@]}"; do
      [ "${SG[i]}" = "$g" ] || continue
      idx+=("$i"); item "$(tx "${SL[i]}")" "$(show_val "$i")" "$(tx "${SH[i]}")"
    done
    n=${#idx[@]}; item "$(tx 'Back')" '' 'Return to the settings.'
    menu "$(tx "$g")"
    [ "$MRES" -ge 0 ] && [ "$MRES" -lt "$n" ] || return 0
    edit_setting "${idx[MRES]}"
    load_cfg; set_theme "$OCUI_THEME"; load_lang
  done
}
export_settings(){
  local f; f="$(desk_dir)/opencode-infinite-settings.env"
  grep -v -i 'token\|password' "$CONF" > "$f" 2>/dev/null || : > "$f"
  say ok "settings saved to $f"; pause
}
import_settings(){ # only known keys with valid values are taken
  local k v i n=0 bad=0
  ask 'Settings file to import' "$(desk_dir)/opencode-infinite-settings.env" || return 0
  [ -f "$ANSWER" ] || { say err "not a file: $ANSWER"; pause; return 0; }
  while IFS='=' read -r k v; do
    for i in "${!SK[@]}"; do
      [ "${SK[i]}" = "$k" ] || continue
      if valid_val "$i" "$v"; then cfg_set "$k" "$v"; n=$(( n + 1 )); else bad=$(( bad + 1 )); fi
    done
  done < "$ANSWER"
  say ok "imported $n setting(s), skipped $bad invalid line(s)."; pause
}
reset_settings(){
  confirm 'Set every setting back to its default? Chats are not touched.' || return 0
  local pat; pat=$(IFS='|'; printf '%s' "${SK[*]}")
  touch "$CONF"; grep -v -E "^($pat)=" "$CONF" > "$CONF.tmp"; mv "$CONF.tmp" "$CONF"
  say ok 'settings are back to their defaults.'; pause
}
support_menu(){
  local -a acts=(export_settings import_settings reset_settings make_shortcut check_updates support_report)
  while :; do
    reset_items; HEAD=(); SHOW_BANNER=0
    item "$(tx 'Export settings')" '' 'Save the settings to a file on the Desktop.'
    item "$(tx 'Import settings')" '' 'Load a settings file. Unknown or invalid lines are skipped.'
    item "$(tx 'Reset settings')" '' 'Set every setting back to its default. Chats are not touched.'
    item "$(tx 'Desktop shortcut')" '' 'Create the OpenCode Infinite launcher icon.'
    item "$(tx 'Check for updates')" '' 'Look for a newer launcher and a newer opencode now.'
    item "$(tx 'Support report')" '' 'Write one text file with versions, settings and the log, for help.'
    item "$(tx 'Back')" '' 'Return to the settings.'
    menu "$(tx 'Support')"
    [ "$MRES" -ge 0 ] && [ "$MRES" -lt 6 ] || return 0
    "${acts[MRES]}"; load_cfg; set_theme "$OCUI_THEME"; load_lang
  done
}
settings(){
  local groups=(Connection Tor 'Proxy list' Rotation Watcher Probe Updates Appearance Shortcuts Logs)
  local help=('Egress, WARP ports and timeouts.' 'Tor ports, bootstrap and install.' 'Free proxy list source and tests.' 'Rotation, IP target and the hunt.' 'Watching OpenCode and resuming.' 'The IP probe.' 'Update prompts.' 'Theme, colors, icons and language.' 'Keys for the closed-OpenCode prompt.' 'Activity log and report privacy.')
  local g i
  while :; do
    reset_items; HEAD=(); SHOW_BANNER=0
    for i in "${!groups[@]}"; do item "$(tx "${groups[i]}")" '' "${help[i]}"; done
    item "$(tx 'Support')" '' 'Export, import, reset settings, shortcut, updates and the support report.'
    item "$(tx 'Back')" '' 'Return to the home screen.'
    menu "$(tx 'Settings')"
    if [ "$MRES" -ge 0 ] && [ "$MRES" -lt "${#groups[@]}" ]; then group_menu "${groups[MRES]}"
    elif [ "$MRES" -eq "${#groups[@]}" ]; then support_menu
    else return 0; fi
  done
}

# ---------------------------------------------------------------- egress: WARP
warp_wc(){ timeout "$WARP_CALL_TIMEOUT" warp-cli --accept-tos "$@" >>"$STATE_DIR/wcli.log" 2>&1; }
warp_check(){ # prints the exit IP when the WARP proxy answers with warp=on
  local out; out=$(curl -s -m 15 -x "http://127.0.0.1:$PROXY_PORT" https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null)
  printf '%s' "$out" | grep -qE '^warp=(on|plus)' || return 1
  printf '%s' "$out" | sed -n 's/^ip=//p'
}
warp_up(){
  command -v warp-cli >/dev/null || { log 'warp-cli missing'; return 1; }
  warp_wc registration show >/dev/null 2>&1 || warp_wc registration new
  warp_wc mode proxy; warp_wc proxy port "$PROXY_PORT"; warp_wc connect
  local i; for i in $(seq 1 "$WARP_WAIT"); do warp-cli --accept-tos status 2>/dev/null | grep -q 'Connected' && break; sleep 1; done
  warp_check >/dev/null
}
warp_rotate(){
  command -v warp-cli >/dev/null || return 1
  warp_wc registration delete; warp_wc registration new || return 1
  warp_up
}

# ---------------------------------------------------------------- egress: TOR (user tor + privoxy bridge)
port_open(){ (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; } # bash builtin, no ss or iproute2 needed
tor_running(){ port_open "$TOR_SOCKS_PORT"; }
tor_start(){
  command -v tor >/dev/null || { log 'tor missing'; return 1; }
  command -v privoxy >/dev/null || { log 'privoxy missing'; return 1; }
  if ! tor_running; then
    tor --SocksPort "$TOR_SOCKS_PORT" --DataDirectory "$STATE_DIR/tor" --Log "notice file $STATE_DIR/tor.log" >/dev/null 2>&1 &
    echo $! > "$STATE_DIR/tor.pid"
    local i; for i in $(seq 1 "$TOR_BOOTSTRAP_WAIT"); do grep -q 'Bootstrapped 100%' "$STATE_DIR/tor.log" 2>/dev/null && break; sleep 1; done
  fi
  printf 'listen-address 127.0.0.1:%s\nforward-socks5t / 127.0.0.1:%s .\n' "$TOR_HTTP_PORT" "$TOR_SOCKS_PORT" > "$STATE_DIR/privoxy.conf"
  if ! port_open "$TOR_HTTP_PORT"; then
    privoxy --no-daemon "$STATE_DIR/privoxy.conf" >/dev/null 2>&1 &
    echo $! > "$STATE_DIR/privoxy.pid"; sleep 2
  fi
  # a port that is open is not enough: the bridge on it must route through Tor
  if curl -s -m 30 -x "http://127.0.0.1:$TOR_HTTP_PORT" https://check.torproject.org/api/ip 2>/dev/null | grep -q '"IsTor":true'; then return 0; fi
  log "tor bridge on $TOR_HTTP_PORT does not route through tor (port busy or tor not ready)"
  return 1
}
tor_stop(){
  [ -f "$STATE_DIR/tor.pid" ] && kill "$(cat "$STATE_DIR/tor.pid")" 2>/dev/null
  pkill -f "DataDirectory $STATE_DIR/tor" 2>/dev/null
  rm -f "$STATE_DIR/tor.pid"
}
tor_check(){ # prints the Tor exit IP when check.torproject.org says IsTor
  local out; out=$(curl -s -m 30 --socks5-hostname "127.0.0.1:$TOR_SOCKS_PORT" https://check.torproject.org/api/ip 2>/dev/null)
  printf '%s' "$out" | grep -q '"IsTor":true' || return 1
  printf '%s' "$out" | sed -n 's/.*"IP":"\([^"]*\)".*/\1/p'
}
tor_rotate(){ tor_stop; sleep 2; tor_start && tor_check >/dev/null; }

# ---------------------------------------------------------------- egress: PROXY list
proxy_pick(){ # the list is a URL or a local file, any format: every ip:port in it is a candidate
  local raw list p code tries=0
  if [ -f "$PROXY_LIST_URL" ]; then raw=$(cat "$PROXY_LIST_URL"); else raw=$(curl -s -m 20 "$PROXY_LIST_URL"); fi
  if [ "$PROXY_LIST_MIN_BYTES" -gt 0 ] && [ "$(printf '%s' "$raw" | wc -c)" -lt "$PROXY_LIST_MIN_BYTES" ]; then log 'proxy list smaller than PROXY_LIST_MIN_BYTES'; return 1; fi
  list=$(printf '%s' "$raw" | grep -oE '[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}:[0-9]{2,5}' | sort -u | shuf | head -n 200)
  [ -n "$list" ] || { log 'proxy list empty'; return 1; }
  while IFS= read -r p; do
    tries=$(( tries + 1 )); [ "$tries" -gt "$PROXY_TRY_MAX" ] && break
    curl -s -m "$PROXY_PROBE_TIMEOUT" -x "http://$p" https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | grep -q '^ip=' || continue
    if [ "$PROXY_API_CHECK" = 1 ]; then
      code=$(curl -s -o /dev/null -w '%{http_code}' -m "$PROXY_PROBE_TIMEOUT" -x "http://$p" "$PROXY_API_CHECK_URL")
      [ "$code" = 000 ] && continue
    fi
    PROXY_URL="http://$p"; return 0
  done <<< "$list"
  return 1
}

# ---------------------------------------------------------------- egress control
egress_up(){
  PROXY_URL=""
  case $EGRESS in
    WARP) warp_up && PROXY_URL="http://127.0.0.1:$PROXY_PORT";;
    TOR) tor_start && PROXY_URL="http://127.0.0.1:$TOR_HTTP_PORT";;
    PROXY) proxy_pick;;
    *) return 0;;
  esac
  [ -n "$PROXY_URL" ]
}
egress_rotate(){ # one new route for the current egress; 0 when it is up
  case $EGRESS in
    WARP) warp_rotate && PROXY_URL="http://127.0.0.1:$PROXY_PORT";;
    TOR) tor_rotate && PROXY_URL="http://127.0.0.1:$TOR_HTTP_PORT";;
    PROXY) proxy_pick;;
    *) return 1;;
  esac
}
trace_get(){ # the Cloudflare trace of the current route, empty when it does not answer
  local args=(); [ -n "${PROXY_URL:-}" ] && args=(-x "$PROXY_URL")
  curl -s -m 15 "${args[@]}" https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null
}
current_ip(){ trace_get | sed -n 's/^ip=//p'; }
route_ok(){ # $1 = trace text. WARP must report warp=on, the others only need an answer
  if [ "$EGRESS" = WARP ]; then printf '%s' "$1" | grep -Eq '^warp=(on|plus)' || return 1; fi
  return 0
}
target_match(){ # target_match <ip> <country>: 0 when every target that is set matches
  [ -z "$TARGET_COUNTRY" ] || [ "${2^^}" = "${TARGET_COUNTRY^^}" ] || return 1
  [ -z "$TARGET_PREFIX" ] || [[ "$1" == "$TARGET_PREFIX"* ]] || return 1
}
probe_ip(){ # 0 = usable, 1 = burned (a limit answer), 2 = the probe itself is broken
  [ "$PROBE" = 1 ] || return 0
  local out rc sid
  oc_runner; export_proxy
  out=$(cd "$HOME" && timeout -k 5 120 "${RUNNER[@]}" run --format json --model "$PROBE_MODEL" "reply with the word ok" 2>&1); rc=$?
  sid=$(printf '%s' "$out" | grep -o 'ses_[A-Za-z0-9]*' | head -n1)
  [ -n "$sid" ] && "${RUNNER[@]}" session delete "$sid" >/dev/null 2>&1
  if printf '%s' "$out" | grep -Eiq "$OC_PAT|usage limit|rate limit|out of usage|insufficient credits|payment required|free usage"; then return 1; fi
  [ "$rc" = 0 ] && return 0
  return 2
}
# hunt_new: rotates until a route passes the target and the probe. 0 = accepted, 1 = gave up
hunt_new(){
  local tries interval goal=0 i t ip gl burned=0 broken=0 start p
  [ "$EGRESS" = NONE ] && { say warn 'Egress is NONE - nothing to rotate.'; return 1; }
  if [ -n "$TARGET_COUNTRY$TARGET_PREFIX" ]; then goal=1; tries=$TARGET_TRIES; interval=$TARGET_INTERVAL; else tries=$ROTATE_TRIES_MAX; interval=$ROTATE_COOLDOWN; fi
  start=$(date +%s)
  for ((i = 1; i <= tries; i++)); do
    if [ "$goal" = 1 ] && [ $(( $(date +%s) - start )) -gt $(( TARGET_MINUTES * 60 )) ]; then say warn 'target hunt: time is up.'; return 1; fi
    printf '\n%s  [%d/%d] rotating...\n' "$MARG" "$i" "$tries"
    if ! egress_rotate; then say warn '  rotation failed'; log 'rotation failed'; sleep "$interval"; continue; fi
    t=$(trace_get)
    ip=$(printf '%s' "$t" | sed -n 's/^ip=//p'); gl=$(printf '%s' "$t" | sed -n 's/^loc=//p')
    if [ -z "$ip" ] || ! route_ok "$t"; then say warn '  route not answering'; sleep "$interval"; continue; fi
    say ok "  exit IP $ip (country $gl)"
    if ! target_match "$ip" "$gl"; then sleep "$interval"; continue; fi
    probe_ip; p=$?
    case $p in
      0) log "accepted $ip $gl"; return 0;;
      1) burned=$(( burned + 1 )); log "burned $ip"; say warn '  IP already burned, rotating again...'
         if [ "$IP_FIND_MAX" -gt 0 ] && [ "$burned" -ge "$IP_FIND_MAX" ]; then say err 'burned IP limit reached.'; return 1; fi
         if [ "$EGRESS" = PROXY ] && [ "$burned" -ge "$PROXY_ROT_MAX" ]; then
           burned=0
           confirm 'Too many burned proxies. Switch this hunt to Tor?' && { EGRESS=TOR; say ok 'switched to Tor for this run.'; }
         fi;;
      *) broken=$(( broken + 1 )); say err "  probe failed for a reason that is not a limit ($broken of $PROBE_BROKEN_MAX)"
         if [ "$broken" -ge "$PROBE_BROKEN_MAX" ]; then say err 'the probe looks broken. Check Probe model in Settings > Probe.'; return 1; fi;;
    esac
    sleep "$interval"
  done
  return 1
}
egress_new(){ hunt_new; }
export_proxy(){
  if [ -n "${PROXY_URL:-}" ]; then export HTTP_PROXY="$PROXY_URL" HTTPS_PROXY="$PROXY_URL" http_proxy="$PROXY_URL" https_proxy="$PROXY_URL"
  else unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; fi
}

# ---------------------------------------------------------------- run OpenCode, watch its log
oc_runner(){ # the command line that runs the real OpenCode (node for the npm build)
  case $OC_REAL in *.js|*.mjs|*.cjs) RUNNER=(node "$OC_REAL");; *) RUNNER=("$OC_REAL");; esac
}
oc_pattern(){ printf '%s' "$OC_REAL" | sed 's/[][\\.^$*+?(){}|]/\\&/g'; }
stop_opencode(){ pkill -TERM -f "$(oc_pattern)" 2>/dev/null; sleep 1; pkill -KILL -f "$(oc_pattern)" 2>/dev/null; return 0; }
watch_log(){ # background: on a limit line, flags LIMIT_FLAG and stops the TUI
  local start=$1 cur="" pos=0 f size
  while sleep 2; do
    f=$(ls -t "$DATA_DIR"/log/*.log 2>/dev/null | head -n1)
    [ -n "$f" ] || continue
    if [ "$f" != "$cur" ]; then
      cur=$f
      if [ "$(stat -c%Y "$f")" -ge "$start" ]; then pos=0; else pos=$(stat -c%s "$f"); fi
    fi
    size=$(stat -c%s "$f")
    if [ "$size" -gt "$pos" ]; then
      if tail -c +$(( pos + 1 )) "$f" | grep -Eiq "$OC_PAT"; then
        : > "$LIMIT_FLAG"; log "limit line seen in $(basename "$f")"
        stop_opencode
        exit 0
      fi
      pos=$size
    fi
  done
}
resume_run(){ # sends RESUME_MSG to the chat, bounded by RESUME_TIMEOUT. 2 = the new IP is limited too
  local folder=$1 out="$STATE_DIR/resume.out" err="$STATE_DIR/resume.err" rc
  local auto=(); [ "$RESUME_AUTO" = 1 ] && auto=(--auto)
  oc_runner; export_proxy
  ( cd "$folder" && timeout -k 5 "$RESUME_TIMEOUT" "${RUNNER[@]}" run "${auto[@]}" -c "$RESUME_MSG" ) >"$out" 2>"$err"
  rc=$?
  if grep -Eiq "$OC_PAT|usage limit|rate limit|out of usage|insufficient credits|payment required" "$out" "$err" 2>/dev/null; then return 2; fi
  return $rc
}
run_session(){ # run_session <folder> [opencode args...]
  local folder=$1; shift
  local cont="" start rc wpid
  [ "${START_CONTINUE:-0}" = 1 ] && cont=1; START_CONTINUE=0
  [ -d "$folder" ] || { say err "folder not found: $folder"; return 1; }
  [ -x "$OC_REAL" ] || { say err 'opencode is not set up. Run "Connect with opencode" first.'; return 1; }
  if [ "${ROUTE_READY:-0}" != 1 ] && ! egress_up; then
    say err "$EGRESS did not come up. Check the egress, then try again."
    log "egress $EGRESS failed to start"; return 1
  fi
  oc_runner
  while :; do
    rm -f "$LIMIT_FLAG"
    export_proxy
    start=$(date +%s); wpid=""
    if [ "$WATCH" = 1 ]; then watch_log "$start" & wpid=$!; fi
    ( cd "$folder" && "${RUNNER[@]}" ${cont:+-c} "$@" ); rc=$?
    [ -n "$wpid" ] && kill "$wpid" 2>/dev/null
    log "opencode exited rc=$rc"
    [ -f "$LIMIT_FLAG" ] || return 0
    rm -f "$LIMIT_FLAG"; stop_opencode
    if [ "$AUTO_ROTATE" != 1 ]; then say warn "limit hit. Pick New IP from the menu."; return 0; fi
    say warn "limit hit: rotating the IP and resuming the chat..."
    if ! egress_new; then say err "no new route after $ROTATE_TRIES_MAX tries."; return 1; fi
    say ok "new route: $(current_ip)"
    resume_run "$folder"; rc=$?
    if [ "$rc" = 2 ]; then say warn "the new IP is limited too. Rotating again."; continue; fi
    cont="--continue"
  done
}
# after_close: OpenCode closed on its own. ON_CLOSE decides between the menu and quitting
after_close(){ # ask: R = new IP and resume the chat, M = menu, Q = quit. The keys come from Settings > Shortcuts
  local folder=$1 k
  [ "$ON_CLOSE" = quit ] && { QUIT=1; return 0; }
  say warn "OpenCode closed. ${KEY_ROTATE^^} = new IP and resume, ${KEY_MENU^^} = menu, ${KEY_QUIT^^} = quit."
  IFS= read -rsn1 k; k=${k^^}
  if [ "$k" = "${KEY_ROTATE^^}" ]; then
    if egress_new; then say ok "new route: $(current_ip)"; resume_run "$folder"; START_CONTINUE=1 run_session "$folder" && after_close "$folder"
    else say err 'no new route.'; pause; fi
  elif [ "$k" = "${KEY_QUIT^^}" ]; then QUIT=1
  fi
}

# ---------------------------------------------------------------- setup: dependencies, shims
PATH_LINE='export PATH="$HOME/.local/bin:$PATH"  # opencode-infinite'
ensure_path(){
  case ":$PATH:" in *":$BIN_DIR:"*) return;; esac
  grep -q 'opencode-infinite' "$HOME/.bashrc" 2>/dev/null || printf '%s\n' "$PATH_LINE" >> "$HOME/.bashrc"
}
write_shims(){ # the commands: opencode (launcher), opencodeinf (menu), opencodeoc (plain OpenCode)
  local app="$APP_DIR/opencode-infinite.sh"
  mkdir -p "$BIN_DIR" "$APP_DIR"
  cp "$SELF" "$app"
  oc_runner
  rm -f "$BIN_DIR/opencode"
  printf '#!/usr/bin/env bash\nexec bash "%s" --run "$@"\n' "$app" > "$BIN_DIR/opencode"
  printf '#!/usr/bin/env bash\nexec bash "%s" "$@"\n' "$app" > "$BIN_DIR/opencodeinf"
  printf '#!/usr/bin/env bash\nexec %s "$@"\n' "${RUNNER[*]}" > "$BIN_DIR/opencodeoc"
  chmod +x "$BIN_DIR/opencode" "$BIN_DIR/opencodeinf" "$BIN_DIR/opencodeoc"
}
find_real_opencode(){ # sets OC_REAL and OC_LINK to the Linux opencode, never a Windows one (/mnt/...) or our own command
  local d p
  for d in ${PATH//:/ } "$HOME/.local/bin" "$HOME/.local/lib/node_modules/opencode-ai/bin"; do
    case $d in /mnt/*) continue;; esac
    for p in "$d"/opencode "$d"/opencode.exe; do
      [ -x "$p" ] || continue
      grep -q 'opencode-infinite' "$p" 2>/dev/null && continue
      OC_LINK=$(readlink "$p" 2>/dev/null || true)
      OC_REAL=$(readlink -f "$p"); return 0
    done
  done
  return 1
}
INSTALL_LOG="$STATE_DIR/install.log"
SUDO=()
sudo_ok(){ # root needs nothing; anyone else gets one sudo password prompt, then the cache covers the rest
  if [ "$(id -u)" -eq 0 ]; then SUDO=(); return 0; fi
  command -v sudo >/dev/null && with_tty sudo -v && { SUDO=(sudo); return 0; }
  return 1
}
# pkg_mgr: apt, dnf, pacman or zypper, empty when none of them is here
pkg_mgr(){
  command -v apt-get >/dev/null && { echo apt; return 0; }
  command -v dnf >/dev/null && { echo dnf; return 0; }
  command -v pacman >/dev/null && { echo pacman; return 0; }
  command -v zypper >/dev/null && echo zypper
  return 0
}
pkg_refresh(){
  case $(pkg_mgr) in
    apt) with_tty "${SUDO[@]}" apt-get update;;
    dnf) with_tty "${SUDO[@]}" dnf makecache;;
    pacman) with_tty "${SUDO[@]}" pacman -Sy --noconfirm;;
    zypper) with_tty "${SUDO[@]}" zypper --non-interactive refresh;;
  esac >>"$INSTALL_LOG" 2>&1
}
pkg_install(){
  case $(pkg_mgr) in
    apt) with_tty "${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y "$@";;
    dnf) with_tty "${SUDO[@]}" dnf install -y "$@";;
    pacman) with_tty "${SUDO[@]}" pacman -S --needed --noconfirm "$@";;
    zypper) with_tty "${SUDO[@]}" zypper --non-interactive install "$@";;
  esac >>"$INSTALL_LOG" 2>&1
}
warp_repo(){ # Cloudflare's own repo for apt and dnf; pacman has none, the client is in the AUR
  local code
  case $(pkg_mgr) in
    apt) code=$(. /etc/os-release; printf '%s' "${VERSION_CODENAME:-${UBUNTU_CODENAME:-}}")
         [ -n "$code" ] || return 1
         pkg_install ca-certificates gnupg || return 1
         curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | with_tty "${SUDO[@]}" gpg --yes --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg || return 1
         printf 'deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ %s main\n' "$code" \
           | with_tty "${SUDO[@]}" tee /etc/apt/sources.list.d/cloudflare-client.list >/dev/null;;
    dnf) curl -fsSL https://pkg.cloudflareclient.com/cloudflare-warp-ascii.repo | with_tty "${SUDO[@]}" tee /etc/yum.repos.d/cloudflare-warp.repo >/dev/null;;
    *) return 1;;
  esac
}
install_warp(){ # the client, and its service where systemd runs
  warp_repo && pkg_refresh && pkg_install cloudflare-warp || { say err 'WARP was not installed. Arch: install cloudflare-warp-bin from the AUR. Others: install cloudflare-warp by hand.'; return 1; }
  command -v systemctl >/dev/null && with_tty "${SUDO[@]}" systemctl enable --now warp-svc >>"$INSTALL_LOG" 2>&1
  return 0
}
apply_setup(){ # shims, saved paths and PATH, the same whether the menu or the automatic start ran it
  write_shims
  cfg_set OC_REAL "$OC_REAL"; cfg_set OC_LINK "$OC_LINK"; cfg_set SETUP_DONE 1
  ensure_path
  log "setup done egress=$EGRESS real=$OC_REAL"
}
install_opencode(){ # npm into ~/.local first, then the official installer; neither needs root
  command -v npm >/dev/null && timeout 900 npm i -g --prefix "$HOME/.local" opencode-ai >>"$INSTALL_LOG" 2>&1
  find_real_opencode && return 0
  curl -fsSL -m 120 https://opencode.ai/install -o "$STATE_DIR/opencode-install.sh" \
    && XDG_BIN_DIR="$HOME/.local/bin" bash "$STATE_DIR/opencode-install.sh" >>"$INSTALL_LOG" 2>&1
  find_real_opencode && return 0
  say err "opencode could not be installed. Log: $INSTALL_LOG"; return 1
}
ensure_deps(){ # installs what is missing, each step on its own: a failed step never stops the next one
  local m want=() warp_need=0 priv_new=0 did=0
  m=$(pkg_mgr)
  command -v warp-cli >/dev/null || warp_need=1
  command -v curl >/dev/null || want+=(curl)
  command -v tor >/dev/null || [ "$TOR_AUTO_INSTALL" = 0 ] || want+=(tor)
  command -v privoxy >/dev/null || [ "$TOR_AUTO_INSTALL" = 0 ] || { want+=(privoxy); priv_new=1; }
  command -v jq >/dev/null || want+=(jq)
  command -v node >/dev/null || want+=(nodejs)
  command -v npm >/dev/null || want+=(npm)
  command -v xdg-user-dir >/dev/null || want+=(xdg-user-dirs)
  if [ "$warp_need" = 1 ] || [ ${#want[@]} -gt 0 ]; then
    did=1
    if [ -z "$m" ]; then say err "no apt, dnf, pacman or zypper here. Install by hand: WARP ${want[*]}"
    elif sudo_ok; then
      say warn "installing what is missing. Keep this window open. Log: $INSTALL_LOG"
      pkg_refresh
      if [ ${#want[@]} -gt 0 ]; then pkg_install "${want[@]}" || say err 'some packages failed. The log has the details.'; fi
      if [ "$priv_new" = 1 ] && command -v systemctl >/dev/null; then with_tty "${SUDO[@]}" systemctl disable --now privoxy >>"$INSTALL_LOG" 2>&1; fi
      if [ "$warp_need" = 1 ]; then install_warp; fi
    else say err "no sudo for this user. Install by hand: WARP ${want[*]}"; fi
  fi
  if ! find_real_opencode; then did=1; say warn 'installing opencode...'; install_opencode; fi
  if [ "$SETUP_DONE" != 1 ] && find_real_opencode; then apply_setup; fi
  [ "$did" = 1 ] && pause
  return 0
}
connect_setup(){
  local -a opts=(ASK WARP TOR PROXY NONE)
  local -a labels=('ASK (pick at each start)' 'WARP (Cloudflare proxy, rotation)' 'TOR (Tor through a privoxy bridge)' 'PROXY (free HTTP list)' 'NONE (direct)')
  local i
  reset_items; HEAD=(); SHOW_BANNER=0
  for i in 0 1 2 3 4; do item "$(tx "${labels[i]}")" "$([ "$OC_EGRESS_DEFAULT" = "${opts[i]}" ] && echo current)" "Default route for OpenCode: ${opts[i]}. The proxy applies only to the OpenCode process."; done
  item "$(tx 'Cancel')" '' 'Leave the setup without changing anything.'
  SEL=0; for i in 0 1 2 3 4; do [ "$OC_EGRESS_DEFAULT" = "${opts[i]}" ] && SEL=$i; done
  menu "$(tx 'Connect with opencode')" ''
  [ "$MRES" -ge 0 ] && [ "$MRES" -lt 5 ] || return 0
  OC_EGRESS_DEFAULT=${opts[MRES]}; EGRESS=$OC_EGRESS_DEFAULT; [ "$EGRESS" = ASK ] && EGRESS=NONE
  OC_REAL=""; OC_LINK=""
  find_real_opencode
  if [ -z "$OC_REAL" ]; then say err "opencode was not found. Install it first: npm i -g opencode-ai"; pause; return 0; fi
  [ -f "$SELF" ] || { say err 'run the script from a file, not from a pipe or process substitution'; pause; return 0; }
  cfg_set OC_EGRESS_DEFAULT "$OC_EGRESS_DEFAULT"; apply_setup
  say ok "setup done: opencode, opencodeinf and opencodeoc are in $BIN_DIR"
  pause
  load_cfg
}
make_shortcut(){
  local dir="$HOME/.local/share/applications" f desk
  mkdir -p "$dir"; f="$dir/opencode-infinite.desktop"
  printf '[Desktop Entry]\nType=Application\nName=OpenCode Infinite\nComment=OpenCode with egress and auto-resume\nExec="%s"\nTerminal=true\nCategories=Development;\n' "$BIN_DIR/opencodeinf" > "$f"
  desk=$(desk_dir); cp "$f" "$desk/opencode-infinite.desktop"; chmod +x "$desk/opencode-infinite.desktop"
  say ok "shortcut: $f and $desk/opencode-infinite.desktop"; pause
}
renew_session(){
  confirm 'Close OpenCode, save auth.json to the Desktop and clear the tokens?' || return 0
  stop_opencode
  local desk; desk=$(desk_dir)
  if [ -f "$DATA_DIR/auth.json" ]; then cp "$DATA_DIR/auth.json" "$desk/auth.json" && rm -f "$DATA_DIR/auth.json" && say ok "auth.json saved to $desk"; fi
  if egress_new || egress_up; then say ok "new route: $(current_ip)"; else say err "no new route."; fi
  log 'renew done'
  pause
}
uninstall(){
  confirm 'Remove the opencode commands and shortcuts and restore the old opencode command? Settings are kept.' || return 0
  rm -f "$BIN_DIR/opencodeinf" "$BIN_DIR/opencodeoc" "$BIN_DIR/opencode"
  rm -f "$HOME/.local/share/applications/opencode-infinite.desktop" "$(desk_dir)/opencode-infinite.desktop"
  [ -n "$OC_LINK" ] && ln -sfn "$OC_LINK" "$BIN_DIR/opencode"
  [ -f "$HOME/.bashrc" ] && sed -i '/opencode-infinite/d' "$HOME/.bashrc"
  cfg_set SETUP_DONE 0
  log 'uninstalled'
  say ok 'removed. The old opencode command is back where it was.'
  pause
  load_cfg
}

# ---------------------------------------------------------------- deep reset and restore
archive_file(){ # copy, compare sizes, delete the original only when they match
  [ -f "$1" ] || return 1
  cp -p "$1" "$2" || return 1
  if [ "$(stat -c%s "$1")" != "$(stat -c%s "$2")" ]; then rm -f "$2"; return 1; fi
  rm -f "$1"
}
deep_reset(){
  local desk stamp target f moved=0
  confirm 'Close every OpenCode, move the chats to the Desktop and clear the saved tokens?' || return 0
  stop_opencode
  desk=$(desk_dir); stamp=$(date +%Y%m%d-%H%M%S)
  target="$desk/opencode_chats_archiviate/$stamp"
  mkdir -p "$target"
  say warn "archiving chats to: $target"
  if [ -d "$DATA_DIR/storage" ] && mv "$DATA_DIR/storage" "$target/storage"; then moved=1; fi
  for f in opencode.db opencode.db-wal opencode.db-shm; do archive_file "$DATA_DIR/$f" "$target/$f" && moved=1; done
  if archive_file "$DATA_DIR/auth.json" "$target/auth.json"; then say ok 'auth.json archived.'; moved=1; fi
  [ -n "$HOME" ] && rm -rf "$HOME/.cache/opencode"
  if [ "$moved" = 0 ]; then rmdir "$target" 2>/dev/null; say warn 'nothing to archive.'
  else say ok 'archived. Tokens cleared.'; log "deep reset to $target"; fi
  pause
}
restore_chats(){ # the chats in place are moved aside to the Desktop, never deleted
  local root desk f keep src d i picks=()
  desk=$(desk_dir); root="$desk/opencode_chats_archiviate"
  for d in "$root"/*/; do [ -d "$d" ] && picks+=("${d%/}"); done
  [ ${#picks[@]} -gt 0 ] || { say warn 'no archived chats found.'; pause; return 0; }
  local -a newest; mapfile -t newest < <(printf '%s\n' "${picks[@]}" | sort -r)
  reset_items; HEAD=(); SHOW_BANNER=0
  for d in "${newest[@]}"; do item "$(basename "$d")" '' "$d"; done
  item "$(tx 'Back')" '' 'Return to the chats menu.'
  menu "$(tx 'Restore chats')"
  [ "$MRES" -ge 0 ] && [ "$MRES" -lt ${#newest[@]} ] || return 0
  src=${newest[MRES]}
  [ -f "$src/opencode.db" ] || [ -d "$src/storage" ] || { say err 'this archive has no chats.'; pause; return 0; }
  confirm "Restore the chats from $(basename "$src")? Auth is not restored." || return 0
  stop_opencode
  keep="$desk/opencode_chats_before_restore/$(date +%Y%m%d-%H%M%S)-$RANDOM"
  mkdir -p "$keep"
  for i in opencode.db opencode.db-wal opencode.db-shm; do [ -e "$DATA_DIR/$i" ] && mv "$DATA_DIR/$i" "$keep/$i"; done
  [ -d "$DATA_DIR/storage" ] && mv "$DATA_DIR/storage" "$keep/storage"
  for f in opencode.db opencode.db-wal opencode.db-shm; do [ -e "$src/$f" ] && cp -p "$src/$f" "$DATA_DIR/$f"; done
  [ -d "$src/storage" ] && cp -rp "$src/storage" "$DATA_DIR/storage"
  say ok "chats restored. The old ones are in $keep"
  log "restored $src"
  pause
}
chats_menu(){
  while :; do
    reset_items; SHOW_BANNER=0; HEAD=()
    item "$(tx 'Deep reset')" '' 'Close OpenCode, move the chats to the Desktop, clear the tokens. Asks first, archives before deleting.' '' err
    item "$(tx 'Restore chats')" '' 'Put back the chats of an archived deep reset. Current chats are moved aside, never deleted.'
    item "$(tx 'Back')" '' 'Return to the main menu.'
    menu "$(tx 'Chats')"
    case $MRES in
      0) deep_reset;;
      1) restore_chats;;
      *) return 0;;
    esac
  done
}

# ---------------------------------------------------------------- updates
update_launcher(){ # offers a newer launcher from the repo; this script is backed up first
  local raw new
  raw=$(curl -fsSL -m 10 "$REPO_RAW/opencode-infinite.sh" 2>/dev/null) || return 0
  new=$(printf '%s\n' "$raw" | sed -n 's/^VERSION="\(.*\)"$/\1/p' | head -n1)
  [ -n "$new" ] && [ "$new" != "$VERSION" ] || return 0
  [ "$(printf '%s\n%s\n' "$VERSION" "$new" | sort -V | tail -n1)" = "$new" ] || return 0
  confirm "Update the launcher from $VERSION to $new? This script is backed up first." || return 0
  printf '%s\n' "$raw" > "$SELF.new" && bash -n "$SELF.new" || { rm -f "$SELF.new"; say err 'the new copy failed the syntax check. Nothing changed.'; pause; return 0; }
  cp "$SELF" "$SELF.bak" && mv "$SELF.new" "$SELF" && chmod +x "$SELF" || { say err 'could not replace the script.'; pause; return 0; }
  [ "$SETUP_DONE" = 1 ] && [ -x "$OC_REAL" ] && write_shims
  log "launcher updated $VERSION -> $new"
  stty sane 2>/dev/null
  exec bash "$SELF" "${ARGS[@]}"
}
update_opencode(){ # offers a newer opencode through npm
  local cur latest
  [ -x "$OC_REAL" ] || return 0
  oc_runner
  cur=$("${RUNNER[@]}" --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)
  latest=$(curl -fsS -m 15 "$OC_API_BASE/cli/opencode/" 2>/dev/null | jq -r '.version // empty' 2>/dev/null)
  [ -n "$latest" ] || latest=$(timeout 20 npm view opencode-ai version 2>/dev/null | head -n1)
  [ -n "$cur" ] && [ -n "$latest" ] && [ "$cur" != "$latest" ] || return 0
  [ "$(printf '%s\n%s\n' "$cur" "$latest" | sort -V | tail -n1)" = "$latest" ] || return 0
  confirm "Update opencode from $cur to $latest through npm?" || return 0
  with_tty timeout 600 npm i -g "opencode-ai@$latest" || say err 'npm update failed.'
  say ok "opencode update step done (was $cur)."; log "opencode update $cur -> $latest"; pause
}
check_updates(){ # auto = at start (silent when offline or equal); manual = from the support menu
  [ "$UPDATE_CHECK" = 1 ] && update_launcher
  update_opencode
  [ "$1" = manual ] && { say ok 'checked. Nothing newer was offered.'; pause; }
  return 0
}

# ---------------------------------------------------------------- support
support_report(){
  local dir="$STATE_DIR/reports" f
  mkdir -p "$dir"; f="$dir/support-$(date +%Y%m%d-%H%M%S).txt"
  oc_runner
  {
    echo "OpenCode Infinite $VERSION"
    echo "date: $(date -Iseconds)"; echo "kernel: $(uname -a)"; echo "bash: $BASH_VERSION"
    echo "opencode: $("${RUNNER[@]}" --version 2>/dev/null || echo none)"
    echo "warp-cli: $(warp-cli --version 2>/dev/null || echo none)"
    echo "tor: $(tor --version 2>/dev/null | head -n1)"
    echo "jq: $(jq --version 2>/dev/null || echo none)"
    echo "--- config (no tokens)"; grep -v -i 'token\|password' "$CONF" 2>/dev/null
    echo "--- launcher.log (last 200 lines, IPs masked)"
    if [ "$LOG_MASK_IP" = 1 ]; then tail -n 200 "$LOG" 2>/dev/null | sed -E 's/([0-9]+\.[0-9]+\.[0-9]+)\.[0-9]+/\1.x/g'; else tail -n 200 "$LOG" 2>/dev/null; fi
  } > "$f"
  say ok "support report: $f"
  pause
}

# ---------------------------------------------------------------- screens
main_menu(){ # the screen after Launch: pick a route and start
  local folder=$1
  while :; do
    reset_items; SHOW_BANNER=0
    HEAD=("${TH[acc]}|  folder: $folder" "${TH[acc]}|  egress: $EGRESS")
    item "$(tx 'New IP and start OpenCode')" '' 'Hunt for a new IP (target and probe), then open OpenCode. Chats stay as they are.'
    item "$(tx 'Start OpenCode')" '' 'Open OpenCode on the current route.'
    item "$(tx 'Change IP (test)')" '' 'Rotate the connection only, without opening OpenCode.'
    item "$(tx 'Chats')" '' 'Deep reset (chats to the Desktop) or restore an archived set.'
    item "$(tx 'Back')" '' 'Return to the home screen.'
    menu "$(tx 'Main menu')"
    case $MRES in
      0) ROUTE_READY=0
         if egress_new; then ROUTE_READY=1; run_session "$folder" && after_close "$folder"
         else say err 'no new route.'; pause; fi;;
      1) ROUTE_READY=0; run_session "$folder" && after_close "$folder";;
      2) if egress_new; then say ok "new route: $(current_ip)"; else say err 'no new route.'; fi; pause;;
      3) chats_menu;;
      *) return 0;;
    esac
    [ "$QUIT" = 1 ] && return 0
  done
}
pick_egress(){ # ASK default: the route for this run only, nothing is saved
  local -a opts=(WARP TOR PROXY NONE) i
  reset_items; HEAD=(); SHOW_BANNER=0
  for i in 0 1 2 3; do item "${opts[i]}" '' "Use ${opts[i]} for this run."; done
  item "$(tx 'Cancel')" '' 'Go back.'
  SEL=0; menu "$(tx 'Route for this run')"
  [ "$MRES" -ge 0 ] && [ "$MRES" -lt 4 ] || return 1
  EGRESS=${opts[MRES]}
}
launch(){
  ask 'Folder to work in' "$PWD" || return 0
  [ -d "$ANSWER" ] || { say err "not a folder: $ANSWER"; pause; return 0; }
  [ "$SETUP_DONE" = 1 ] || { say warn 'Connect with opencode first, so the opencode command is set.'; pause; return 0; }
  if [ "$OC_EGRESS_DEFAULT" = ASK ]; then pick_egress || return 0; fi
  main_menu "$ANSWER"
}
home(){
  local CHECKED=0 act
  while :; do
    load_cfg; set_theme "$OCUI_THEME"; load_lang
    if [ "$CHECKED" = 0 ]; then CHECKED=1; ensure_deps; load_cfg; set_theme "$OCUI_THEME"; load_lang; [ "$UPDATE_ASK" = ask ] && check_updates auto; fi
    reset_items; SHOW_BANNER=1; HEAD=()
    local -a acts=()
    item "$(tx 'Launch OpenCode')" '' 'Pick a folder and a connection, then start OpenCode.'; acts+=(launch)
    if [ "$SETUP_DONE" = 1 ]; then
      item "$(tx 'Connect with opencode')" "Configured - $OC_EGRESS_DEFAULT" 'Connection and commands. Run it again to change the egress.'; acts+=(connect_setup)
      item "$(tx 'Renew session')" '' 'Use it when the limit is hit or the login expired: saves auth.json to the Desktop, clears tokens, gets a new IP.'; acts+=(renew_session)
      item "$(tx 'Uninstall')" '' 'Removes the opencode commands and shortcuts and restores the old opencode command. Asks first.' '' err; acts+=(uninstall)
    else
      item "$(tx 'Connect with opencode')" 'Not configured' 'Guided setup: installs what is missing, then WARP, Tor, a proxy list or direct. Creates opencode, opencodeinf and opencodeoc.' '' warn; acts+=(connect_setup)
    fi
    item "$(tx 'Settings')" '' 'View and change the launcher options. Saved at once.'; acts+=(settings)
    item "$(tx 'Support report')" '' 'Write one text file with versions, settings and the log, for help.'; acts+=(support_report)
    item "$(tx 'Exit')" '' 'Close the launcher.'; acts+=(quit)
    menu 'OpenCode Infinite' "$VERSION"
    [ "$MRES" -lt 0 ] && return 0
    act=${acts[MRES]}
    [ "$act" = quit ] && return 0
    "$act"
    [ "$QUIT" = 1 ] && return 0
  done
}
cleanup(){
  printf '\e[?25h\e[0m'
  stty sane 2>/dev/null
  [ -f "$STATE_DIR/tor.pid" ] && tor_stop
  [ -f "$STATE_DIR/privoxy.pid" ] && kill "$(cat "$STATE_DIR/privoxy.pid")" 2>/dev/null && rm -f "$STATE_DIR/privoxy.pid"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------- entry (OCI_NO_MAIN=1 loads the functions only, for tests)
if [ -z "${OCI_NO_MAIN:-}" ]; then
  load_cfg
  set_theme "$OCUI_THEME"
  shopt -s checkwinsize
  stty -echo -icanon 2>/dev/null
  printf '\e[?25l'
  SEL=0; MRES=0; QUIT=0; ROUTE_READY=0
  case ${1:-} in
    --run) shift; ensure_deps; run_session "$PWD" "$@"; exit $?;;
    *)     home;;
  esac
fi
