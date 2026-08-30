# Notice

QBSheet is derived from the first-party browser scorekeeper in the
[YellowFruit/Fruity](https://github.com/YellowFruit/YellowFruit) project.

The extraction began from source commit `970ac055`. The standalone repository preserves the original
AGPLv3-or-later licensing and the first-party scorer's contributor attribution. The extracted scorer
is being made canonical here; Fruity's in-tree copy is transitional until a shared package or an
equivalent synchronization boundary is completed.

## Third-party code in the built application

A build of QBSheet includes [jsQR](https://github.com/cozmo/jsQR), used to read QR codes on browsers
that do not implement the `BarcodeDetector` API. jsQR is copyright its contributors and is licensed
under the Apache License, Version 2.0. Its license text ships with the package.

This notice is informational and does not replace the terms of [`LICENSE`](LICENSE) or any copyright
headers retained in individual source files.
