#!/usr/bin/env bash
# Состояние проекта одной командой: следующий номер ТЗ и что в работе.
set -euo pipefail
cd "$(dirname "$0")/.."

echo
echo "  ТЗ"
last=0
for f in docs/specs/[0-9][0-9][0-9]-*.md; do
  [ -e "$f" ] || continue
  n=$(basename "$f" | cut -c1-3)
  st=$(grep -m1 '^Статус:' "$f" | sed 's/^Статус: *//; s/ *·.*//')
  name=$(grep -m1 '^# ТЗ' "$f" | sed 's/^# ТЗ [0-9]* — //')
  printf '    %s  %s  ·  %s\n' "$n" "$name" "$st"
  last=$((10#$n))
done
printf '\n  Следующий свободный номер: %03d\n\n' $((last + 1))

echo "  Данные"
node -e '
const d=JSON.parse(require("fs").readFileSync("client.json","utf8"));
const miss=[];(function w(n,t){if(n===null)return miss.push(t);
if(Array.isArray(n))return n.forEach((v,i)=>w(v,t+"["+i+"]"));
if(typeof n==="object")Object.entries(n).filter(([k])=>!k.startsWith("_")).forEach(([k,v])=>w(v,t?t+"."+k:k))})(d,"");
console.log("    ответов в библиотеке: "+d.answers.length);
const opt=new Set(d._optional||[]);const block=miss.filter(m=>!opt.has(m));
console.log("    блокирует сборку: "+(block.length?block.join(", "):"ничего"));
console.log("    помечено неприменимым: "+miss.filter(m=>opt.has(m)).length);'
echo
echo "  Git"
printf '    ветка %s, коммитов %s, незакоммиченного %s\n\n' \
  "$(git branch --show-current)" "$(git rev-list --count HEAD)" "$(git status --porcelain | wc -l | tr -d ' ')"
