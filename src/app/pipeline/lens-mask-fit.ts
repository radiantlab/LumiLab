import type { MaskBox } from "./build-pipeline-params";

/**
 * Explains why the lens mask cannot be cropped out of the image, or returns
 * null when it fits.
 *
 * `crop` cuts out the square circumscribing the mask circle, so the whole
 * square has to lie inside the picture. Radiance is only told about the
 * y axis, and rejects a square that hangs off the top or bottom
 * (`crop.rs`), but a square hanging off the left or right is not rejected,
 * `pcompos` just pads the missing columns with black. Both are checked here,
 * because both produce a picture the user did not ask for.
 *
 * This runs before the pipeline starts. Without it the y-axis case surfaces
 * from Rust three stages in, after every exposure has already been merged,
 * and the x-axis case never surfaces at all.
 */
export function describeMaskOverflow(
  mask: MaskBox,
  size: [width: number, height: number]
): string | null {
  const [width, height] = size;
  if (!(width > 0 && height > 0)) {
    return null;
  }

  const { diameter, xleft, ytop } = mask;

  // Reported first: a mask wider than the picture cannot be moved into place,
  // so telling the user to reposition it would be wrong advice.
  if (diameter > width || diameter > height) {
    const limit = Math.floor(Math.min(width, height) / 2);
    return (
      `The lens mask is ${diameter} px across, which does not fit in an image ` +
      `${width}x${height} px. Reduce the radius to ${limit} or less.`
    );
  }

  const overflows =
    ytop < 0 ||
    xleft < 0 ||
    ytop + diameter > height ||
    xleft + diameter > width;

  if (overflows) {
    return (
      `The lens mask reaches outside the image. It spans x ${xleft} to ` +
      `${xleft + diameter} and y ${ytop} to ${ytop + diameter}, but the image ` +
      `is ${width}x${height} px. Move the mask back inside it, or reduce the radius.`
    );
  }

  return null;
}
