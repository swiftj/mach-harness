#!/bin/sh
# sheet.sh name n  -> a contact sheet of n frames (2 columns) for a look
S=/private/tmp/claude-501/-Users-johnswift-Projects-mach-harness/4cf98ed8-7452-4d90-8d38-55769b828040/scratchpad/f
mkdir -p $S; rm -f $S/c-$1-*.png
V=/Users/johnswift/Projects/mach-harness/video/public/footage/$1.mp4
D=$(/opt/homebrew/bin/ffprobe -v error -show_entries format=duration -of csv=p=0 $V)
i=0
while [ $i -lt $2 ]; do
  T=$(printf "%.3f" $(echo "$D * ($i + 0.5) / $2" | bc -l))
  /opt/homebrew/bin/ffmpeg -loglevel error -y -ss $T -i $V -frames:v 1 -vf scale=640:-1 $S/c-$1-$i.png
  i=$((i+1))
done
/opt/homebrew/bin/ffmpeg -loglevel error -y -pattern_type glob -i "$S/c-$1-*.png" -filter_complex "tile=2x$(( ($2+1)/2 ))" $S/sheet-$1.png
echo $S/sheet-$1.png
