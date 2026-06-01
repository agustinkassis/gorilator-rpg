# Character model

Drop a glTF-binary character here as **`knight.glb`** to replace the capsule
placeholder with a real low-poly animated knight.

## Requirements

A single `.glb` containing animation groups whose **names contain** (case-insensitive):

| State  | Name contains one of            |
| ------ | ------------------------------- |
| idle   | `idle`                          |
| walk   | `walk`, `run`, `jog`            |
| attack | `attack`, `slash`, `swing`      |
| hit    | `hit`, `damage`, `recieve`, `react` |
| death  | `death`, `die`, `dead`          |

The loader matches names loosely and logs the groups it found to the browser
console, so you can see what was detected and adjust.

## Recommended free source (CC0)

**Quaternius — LowPoly Animated Knight**: <https://quaternius.com/>
(also on itch.io / OpenGameArt). It ships `.blend` / `.fbx` with Idle, Walk,
Run, Attack, Death, etc. Export to glTF binary:

- **Blender**: open the `.blend`, then *File → Export → glTF 2.0 (.glb)* with
  "Include → Animations" enabled. Save as `knight.glb` here.
- **CLI**: `npx fbx2gltf -b -i Knight.fbx -o knight.glb`

The model should be roughly **1.8 units tall** and face **+Z**. If yours faces a
different axis or is a different scale, tweak `MODEL_FORWARD_OFFSET` / scaling in
`src/entities/CharacterFactory.ts`.
