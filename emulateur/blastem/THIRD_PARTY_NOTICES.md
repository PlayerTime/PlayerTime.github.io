# Third-party notices

`blastem.wasm` / `blastem.js` are **BlastEm** compiled to WebAssembly. Besides BlastEm itself
(GPL-3.0-or-later, see [LICENSE](LICENSE)), the binary contains the components below. Their
licences are reproduced in full.

| Component | Version | Licence | Where it comes from |
| --- | --- | --- | --- |
| BlastEm | `6d1a7447ee9e` (v1.0.0+22) | GPL-3.0-or-later | https://www.retrodev.com/repos/blastem — fetched and SHA-256-checked by `scripts/build-blastem.sh` |
| SDL2 | 2.32.0 | zlib | Emscripten's `sdl2` port |
| zlib | bundled with BlastEm | zlib | `zlib/` in BlastEm's source |
| Zstandard | bundled with BlastEm | BSD-3-Clause (dual BSD / GPLv2; used under BSD) | `zstd/` in BlastEm's source |
| Nuklear | bundled with BlastEm | Public domain, or a perpetual permissive grant | `nuklear_ui/nuklear.h` in BlastEm's source |
| Roboto Regular | v2.138 | Apache-2.0 | https://github.com/googlefonts/roboto — BlastEm's UI font, SHA-256-checked by the build |

## BlastEm

Copyright 2013-2016 Michael Pavone and contributors (as stated in the source headers). BlastEm is free software distributed under the terms of the
GNU General Public License version 3 or greater. See [LICENSE](LICENSE).

## SDL2 (zlib licence)

```
Copyright (C) 1997-2025 Sam Lantinga <slouken@libsdl.org>
  
This software is provided 'as-is', without any express or implied
warranty.  In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:
  
1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required. 
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.

```

## zlib (zlib licence)

```
Copyright notice:

 (C) 1995-2022 Jean-loup Gailly and Mark Adler

  This software is provided 'as-is', without any express or implied
  warranty.  In no event will the authors be held liable for any damages
  arising from the use of this software.

  Permission is granted to anyone to use this software for any purpose,
  including commercial applications, and to alter it and redistribute it
  freely, subject to the following restrictions:

  1. The origin of this software must not be misrepresented; you must not
     claim that you wrote the original software. If you use this software
     in a product, an acknowledgment in the product documentation would be
     appreciated but is not required.
  2. Altered source versions must be plainly marked as such, and must not be
     misrepresented as being the original software.
  3. This notice may not be removed or altered from any source distribution.

  Jean-loup Gailly        Mark Adler
  jloup@gzip.org          madler@alumni.caltech.edu
```

## Zstandard (BSD-3-Clause)

```
BSD License

For Zstandard software

Copyright (c) Meta Platforms, Inc. and affiliates. All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

 * Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

 * Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

 * Neither the name Facebook, nor Meta, nor the names of its contributors may
   be used to endorse or promote products derived from this software without
   specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Nuklear

```
LICENSE:
    This software is dual-licensed to the public domain and under the following
    license: you are granted a perpetual, irrevocable license to copy, modify,
    publish and distribute this file as you see fit.
```

## Roboto (Apache License 2.0)

Copyright 2011 Google Inc. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License"); you may not use this font except
in compliance with the License. You may obtain a copy of the License at
https://www.apache.org/licenses/LICENSE-2.0 — distributed on an "AS IS" BASIS, WITHOUT
WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
