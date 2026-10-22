/**
 * Display name of the product this fork ships.
 *
 * Shared by the packaging configuration (which also derives the install directory and the
 * single-instance lock from it) and the post-build smoke check (which launches the packed
 * executable by this name). Keeping one source means renaming the product cannot desynchronise
 * the two and turn a packaging run into a phantom launch failure.
 */
export const DESKTOP_PRODUCT_NAME = 'DSH Desktop'
