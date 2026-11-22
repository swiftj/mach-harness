#!/bin/sh
# frames.sh name  -> three frames (start, middle, end) in the scratchpad for a look
S=/private/tmp/claude-501/-Users-johnswift-Projects-mach-harness/4cf98ed8-7452-4d90-8d38-55769b828040/scratchpad/f
mkdir -p $S
D=$(/opt/homebrew/bin/ffprobe -v error -show_entries format=duration -of csv=p=0 /Users/johnswift/Projects/mach-harness/video/public/footage/$1.mp4)
for p in 0.1 0.5 0.92; do
  T=$(echo "$D * $p" | bc -l)
  /opt/homebrew/bin/ffmpeg -loglevel error -y -ss $T -i /Users/johnswift/Projects/mach-harness/video/public/footage/$1.mp4 -frames:v 1 -vf scale=960:-1 $S/$1-$p.png
done
ls $S | grep $1
F=$S
/opt/homebrew/bin/ffmpeg -loglevel error -y -i $F/$1-0.1.png -i $F/$1-0.5.png -i $F/$1-0.92.png -filter_complex "[0][1][2]vstack=3" $F/$1-sheet.png
