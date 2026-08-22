/**
 * The pixels the mod has told us about since the last save, kept ready to draw.
 *
 * Deltas arrive many times a second, so nothing here re-renders anything: columns are
 * written straight into a Uint32 buffer and only the rectangle that actually changed is
 * pushed to the canvas on the next frame. A second buffer marks the burning columns, which
 * the map draws blurred and additively to get the glow of a fire.
 */

/** Flag bit the mod sets on columns that are on fire or under lava. */
export const HOT = 1 << 0;

/** The live area only ever grows, and in steps this size, so growth is rare. */
const PAD = 256;

export interface LayerBounds {
  origin_x: number;
  origin_z: number;
  width: number;
  height: number;
}

type Rect = { x0: number; z0: number; x1: number; z1: number };

export class LiveLayer {
  originX = 0;
  originZ = 0;
  width = 0;
  height = 0;
  /** how many columns are currently burning */
  hot = 0;

  private surfacePixels = new Uint32Array(0);
  private heatPixels = new Uint32Array(0);
  private surfaceImage: ImageData | null = null;
  private heatImage: ImageData | null = null;
  private surfaceDirty: Rect | null = null;
  private heatDirty: Rect | null = null;
  private hotKeys = new Set<number>();

  readonly surface = document.createElement("canvas");
  readonly heat = document.createElement("canvas");

  /** True once there is anything worth drawing. */
  get ready() {
    return this.width > 0 && this.height > 0;
  }

  /** Throws away everything and sizes the layer to `bounds`. */
  reset(bounds: LayerBounds) {
    this.originX = bounds.origin_x;
    this.originZ = bounds.origin_z;
    this.resize(Math.max(1, bounds.width), Math.max(1, bounds.height), null);
    this.hotKeys.clear();
    this.hot = 0;
  }

  /** Seeds the layer from the snapshot PNG the server renders. */
  adopt(image: CanvasImageSource, bounds: LayerBounds) {
    this.reset(bounds);
    const ctx = this.surface.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.drawImage(image, 0, 0);
    // pull it back out so the buffer and the canvas agree
    const data = ctx.getImageData(0, 0, this.width, this.height);
    this.surfaceImage = data;
    this.surfacePixels = new Uint32Array(data.data.buffer);
    this.surfaceDirty = null;
  }

  /**
   * Marks the columns the server says are burning.
   *
   * The snapshot image carries colours but not flags, so without this a dashboard that
   * reloads mid-fire would show the burn scar with no glow over it.
   */
  seedHot(fires: [number, number][]) {
    this.hotKeys.clear();
    this.heatPixels.fill(0);
    for (const [x, z] of fires) {
      if (!this.covers(x, z)) continue;
      const index = (z - this.originZ) * this.width + (x - this.originX);
      if (index < 0 || index >= this.heatPixels.length) continue;
      this.heatPixels[index] = 0xffffffff;
      this.hotKeys.add(index);
      this.mark("heatDirty", x, z);
    }
    this.hot = this.hotKeys.size;
  }

  /**
   * Applies one delta. `columns` is flat: x, z, packed, where packed carries the flags in
   * its top byte and the colour in the low three.
   */
  apply(columns: number[]) {
    for (let i = 0; i + 2 < columns.length; i += 3) {
      const x = columns[i];
      const z = columns[i + 1];
      const packed = columns[i + 2] >>> 0;
      if (!this.covers(x, z)) this.grow(x, z);

      const index = (z - this.originZ) * this.width + (x - this.originX);
      if (index < 0 || index >= this.surfacePixels.length) continue;

      // canvas pixels are little-endian ABGR
      const r = (packed >>> 16) & 0xff;
      const g = (packed >>> 8) & 0xff;
      const b = packed & 0xff;
      this.surfacePixels[index] = (255 << 24) | (b << 16) | (g << 8) | r;
      this.mark("surfaceDirty", x, z);

      const key = index;
      const burning = ((packed >>> 24) & HOT) !== 0;
      if (burning !== this.hotKeys.has(key)) {
        if (burning) this.hotKeys.add(key);
        else this.hotKeys.delete(key);
        this.heatPixels[index] = burning ? 0xffffffff : 0;
        this.mark("heatDirty", x, z);
      }
    }
    this.hot = this.hotKeys.size;
  }

  /** Pushes whatever changed into the canvases. Call once per frame, before drawing. */
  flush() {
    this.blit(this.surface, this.surfaceImage, this.surfaceDirty);
    this.surfaceDirty = null;
    this.blit(this.heat, this.heatImage, this.heatDirty);
    this.heatDirty = null;
  }

  // ------------------------------------------------------------------ internals

  private blit(canvas: HTMLCanvasElement, image: ImageData | null, rect: Rect | null) {
    if (!image || !rect) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = rect.x1 - rect.x0 + 1;
    const h = rect.z1 - rect.z0 + 1;
    ctx.putImageData(image, 0, 0, rect.x0, rect.z0, w, h);
  }

  private mark(which: "surfaceDirty" | "heatDirty", worldX: number, worldZ: number) {
    const x = worldX - this.originX;
    const z = worldZ - this.originZ;
    const rect = this[which];
    if (!rect) {
      this[which] = { x0: x, z0: z, x1: x, z1: z };
      return;
    }
    if (x < rect.x0) rect.x0 = x;
    if (x > rect.x1) rect.x1 = x;
    if (z < rect.z0) rect.z0 = z;
    if (z > rect.z1) rect.z1 = z;
  }

  private covers(x: number, z: number) {
    return x >= this.originX && z >= this.originZ
      && x < this.originX + this.width && z < this.originZ + this.height;
  }

  /** Expands to take in a column that fell outside, in {@link PAD}-block steps. */
  private grow(x: number, z: number) {
    const originX = Math.min(this.originX, Math.floor((x - PAD) / PAD) * PAD);
    const originZ = Math.min(this.originZ, Math.floor((z - PAD) / PAD) * PAD);
    const right = Math.max(this.originX + this.width, Math.ceil((x + PAD) / PAD) * PAD);
    const bottom = Math.max(this.originZ + this.height, Math.ceil((z + PAD) / PAD) * PAD);

    const previous = {
      surface: this.surfacePixels,
      heat: this.heatPixels,
      originX: this.originX,
      originZ: this.originZ,
      width: this.width,
      height: this.height,
    };

    this.originX = originX;
    this.originZ = originZ;
    this.resize(right - originX, bottom - originZ, previous);
  }

  private resize(
    width: number,
    height: number,
    previous: { surface: Uint32Array; heat: Uint32Array; originX: number; originZ: number; width: number; height: number } | null,
  ) {
    this.width = width;
    this.height = height;
    this.surface.width = width;
    this.surface.height = height;
    this.heat.width = width;
    this.heat.height = height;

    this.surfaceImage = new ImageData(width, height);
    this.heatImage = new ImageData(width, height);
    this.surfacePixels = new Uint32Array(this.surfaceImage.data.buffer);
    this.heatPixels = new Uint32Array(this.heatImage.data.buffer);

    if (previous) {
      const offsetX = previous.originX - this.originX;
      const offsetZ = previous.originZ - this.originZ;
      for (let z = 0; z < previous.height; z++) {
        const from = z * previous.width;
        const to = (z + offsetZ) * width + offsetX;
        this.surfacePixels.set(previous.surface.subarray(from, from + previous.width), to);
        this.heatPixels.set(previous.heat.subarray(from, from + previous.width), to);
      }
      // everything moved, so the whole thing needs pushing to the canvas again
      this.surfaceDirty = { x0: 0, z0: 0, x1: width - 1, z1: height - 1 };
      this.heatDirty = { x0: 0, z0: 0, x1: width - 1, z1: height - 1 };
      this.rebuildHotKeys();
    }
  }

  private rebuildHotKeys() {
    this.hotKeys.clear();
    for (let i = 0; i < this.heatPixels.length; i++) {
      if (this.heatPixels[i]) this.hotKeys.add(i);
    }
    this.hot = this.hotKeys.size;
  }
}
