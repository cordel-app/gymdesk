// #1527 follow-up — the pure half of re-cropping an exercise image stored
// before exercise uploads switched from `contain` to `cover`.
//
// A stored master is already a 1080 square: a non-square source was fitted
// whole and the rest filled with fully transparent rows (top and bottom) or
// columns (left and right). The original is gone, so the only way to the
// cropped square is to cut those bands off and crop what is left. This decides
// where the picture is inside the square, and only for that signature: the
// picture spans the **whole** of one axis and the bands on the other are
// fully transparent. A cutout figure on a transparent background (it touches
// neither pair of edges) is not padding, and nothing is returned for it, so it
// is never cropped by this script.

export interface PictureBox { left: number; top: number; width: number; height: number }

/**
 * Where the picture sits inside a contained square, or `null` when there is
 * no transparent padding to remove. `data` is raw RGBA, `width × height × 4`.
 */
export function containedPictureBox(data: Uint8Array, width: number, height: number): PictureBox | null {
  const opaqueRow = (y: number) => {
    for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] !== 0) return true;
    return false;
  };
  const opaqueCol = (x: number) => {
    for (let y = 0; y < height; y++) if (data[(y * width + x) * 4 + 3] !== 0) return true;
    return false;
  };
  let top = 0;
  while (top < height && !opaqueRow(top)) top++;
  if (top === height) return null; // fully transparent: nothing to show
  let bottom = height - 1;
  while (bottom > top && !opaqueRow(bottom)) bottom--;
  let left = 0;
  while (left < width && !opaqueCol(left)) left++;
  let right = width - 1;
  while (right > left && !opaqueCol(right)) right--;

  const rowsPadded = top > 0 || bottom < height - 1;
  const colsPadded = left > 0 || right < width - 1;
  // `contain` pads exactly one axis and the picture spans the other edge to edge.
  if (rowsPadded === colsPadded) return null;
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}
