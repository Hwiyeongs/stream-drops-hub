from PIL import Image, ImageDraw

def create_icon(size, output_path):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Background rounded rectangle
    radius = size // 4
    # Dark modern violet/slate background
    bg_color = (24, 24, 37, 255) # Catppuccin mocha crust
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=bg_color)
    
    # Draw a stylized gift/drop box
    margin = size * 0.2
    box_top = size * 0.4
    box_bottom = size * 0.8
    box_left = margin
    box_right = size - margin
    
    # Box body: purple to cyan/green gradient approximation
    body_color = (145, 70, 255, 255) # Twitch Purple
    lid_color = (0, 255, 163, 255)    # Chzzk Green
    ribbon_color = (0, 130, 255, 255) # SOOP Blue
    
    # Lid
    lid_top = size * 0.28
    lid_bottom = size * 0.38
    lid_margin = size * 0.15
    draw.rounded_rectangle([lid_margin, lid_top, size - lid_margin, lid_bottom], radius=max(1, int(size*0.06)), fill=lid_color)
    
    # Body
    draw.rounded_rectangle([box_left, box_top, box_right, box_bottom], radius=max(1, int(size*0.06)), fill=body_color)
    
    # Vertical ribbon
    ribbon_width = max(1, int(size * 0.12))
    ribbon_x1 = (size - ribbon_width) // 2
    ribbon_x2 = ribbon_x1 + ribbon_width
    draw.rectangle([ribbon_x1, box_top, ribbon_x2, box_bottom], fill=ribbon_color)
    draw.rectangle([ribbon_x1, lid_top, ribbon_x2, lid_bottom], fill=ribbon_color)
    
    # Sparkle / star on top
    if size >= 32:
        sparkle_color = (255, 255, 255, 240)
        cx = size * 0.72
        cy = size * 0.22
        r = size * 0.08
        draw.polygon([(cx, cy - r), (cx + r*0.4, cy - r*0.4), (cx + r, cy), (cx + r*0.4, cy + r*0.4),
                      (cx, cy + r), (cx - r*0.4, cy + r*0.4), (cx - r, cy), (cx - r*0.4, cy - r*0.4)], fill=sparkle_color)

    img.save(output_path, "PNG")
    print(f"Saved {output_path}")

create_icon(16, "icons/icon-16.png")
create_icon(48, "icons/icon-48.png")
create_icon(128, "icons/icon-128.png")
