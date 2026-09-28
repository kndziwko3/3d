import sys, glob
from PIL import Image
out = sys.argv[1]; cols = int(sys.argv[2]); files = sys.argv[3:]
ims = [Image.open(f).convert('RGB') for f in files]
w = 640; h = int(ims[0].height * w / ims[0].width)
rows = (len(ims) + cols - 1) // cols
sheet = Image.new('RGB', (cols * w, rows * h))
for i, im in enumerate(ims):
    sheet.paste(im.resize((w, h), Image.LANCZOS), ((i % cols) * w, (i // cols) * h))
sheet.save(out)
