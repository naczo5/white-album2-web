# Third-party notices

This fan project is not affiliated with or endorsed by Leaf/Aquaplus. Game
assets and translation files are not distributed by this repository and
remain the property of their respective owners.

## MAO-TLs — WHITE ALBUM 2 v2.1.0 English release

When built with an English translation, scenario text comes from the
user-supplied MAO-TLs v2.1.0 release (Project Lead MAO; Astra revision;
Special Thanks gambs). The upstream release has no license file.

See the release's `THIRD_PARTY_NOTICES` for the authoritative attribution
and license text shipped by the translation project.

## Todokanai TL — BSD-3-Clause

The translation lineage includes Todokanai TL
(<https://github.com/TodokanaiTL/WA2EnglishPatch>), which can also be built
and selected directly as an optional second translation (used with permission
from the Todokanai TL team). The upstream project is distributed under the
BSD 3-Clause License.

Copyright (c) the Todokanai TL contributors (see the upstream repository
for the exact copyright notice).

```text
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS
IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Avuxo/Ben — MIT

Subtitle lineage includes work by Avuxo/Ben, distributed under the MIT
License.

Copyright (c) the Avuxo/Ben contributors (see the upstream repository for
the exact copyright notice).

```text
Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT
OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR
THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## galhack/WhiteAlbum2_iOS — Apache-2.0 / MIT (reference and cross-validation)

Unofficial native Godot port of WHITE ALBUM 2 for Apple platforms:
<https://github.com/galhack/WhiteAlbum2_iOS>.

- WA2 Godot porting code: Apache License, Version 2.0.
  Copyright 2026 WA2 Godot port contributors.
- `addons/wmv_video` WMV Video GDExtension: MIT License.
- The complete upstream license texts are in that repository's `LICENSE`,
  `LICENSES/Apache-2.0.txt` and `addons/wmv_video/LICENSE`.

This project used `galhack/WhiteAlbum2_iOS` as a **reference and
cross-validation source**, and **reproduces two functional tables** from its
Apache-2.0 code: the 33-entry CK-GAL private glyph map
(`script/Wa2Encoding.cs`) and the 24-row scene-replay table
(`script/Wa2Def.cs`, `SceneSlots`). The web engine, player and all other data
formats here are independent implementations. The material used is
functional, not expressive:
engine/script identifiers; the 33-glyph CK-GAL private glyph map for save
text; PC save layout handling (`ScriptPos`, jump stack, locals, args) and
its fail-closed conversion rules; LSCR `(4,2)` same-script call and
helper-entry semantics; weather/shake/calendar behavior notes; the shape of
a timed-caption schema (our JSON schema is independent); and CG
gallery/scene replay slot tables.

No game content was copied from that project or is distributed here: no
scenario text, images, audio, movies, fonts or bundled subtitle data. All
game assets remain user-supplied.

The full Apache-2.0 license text is included in
[`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt) and is also available at
<https://www.apache.org/licenses/LICENSE-2.0>.
