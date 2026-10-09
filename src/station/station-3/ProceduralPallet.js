import * as THREE from 'three';

function mesh(geometry, material, name, parent) {
  const object = new THREE.Mesh(geometry, material);
  object.name = name;
  object.castShadow = true;
  object.receiveShadow = true;
  parent.add(object);
  return object;
}

/**
 * Industrial wood pallet sized to the stack footprint.
 * Root origin is the pallet center on the floor; topSurface.y is the deck top.
 */
export function createProceduralPallet({ length, width, height }) {
  const root = new THREE.Group();
  root.name = 'ProceduralPallet';

  const wood = new THREE.MeshStandardMaterial({ color: 0x8b6914, roughness: 0.82, metalness: 0.04 });
  const woodDark = new THREE.MeshStandardMaterial({ color: 0x6b4f10, roughness: 0.88, metalness: 0.03 });
  const woodEnd = new THREE.MeshStandardMaterial({ color: 0xa07818, roughness: 0.78, metalness: 0.04 });

  const deckThickness = Math.min(0.022, height * 0.16);
  const blockHeight = height - deckThickness * 2;
  const stringerHeight = Math.max(0.018, deckThickness * 0.85);
  const topY = height;
  const deckTopY = topY - deckThickness / 2;
  const deckBottomY = stringerHeight / 2;
  const blockY = stringerHeight + blockHeight / 2;

  const boardCount = 7;
  const boardGap = 0.018;
  const boardWidth = (width - boardGap * (boardCount - 1)) / boardCount;
  for (let index = 0; index < boardCount; index += 1) {
    const z = -width / 2 + boardWidth / 2 + index * (boardWidth + boardGap);
    const board = mesh(
      new THREE.BoxGeometry(length, deckThickness, boardWidth),
      index % 2 === 0 ? wood : woodDark,
      `Top deck board ${index + 1}`,
      root,
    );
    board.position.set(0, deckTopY, z);
  }

  const bottomBoardCount = 3;
  const bottomBoardWidth = width * 0.22;
  [-width / 2 + bottomBoardWidth / 2, 0, width / 2 - bottomBoardWidth / 2].forEach((z, index) => {
    const board = mesh(
      new THREE.BoxGeometry(length, stringerHeight, bottomBoardWidth),
      woodDark,
      `Bottom board ${index + 1}`,
      root,
    );
    board.position.set(0, deckBottomY, z);
  });

  const blockSizeX = length * 0.14;
  const blockSizeZ = width * 0.16;
  const blockXs = [-length / 2 + blockSizeX / 2, 0, length / 2 - blockSizeX / 2];
  const blockZs = [-width / 2 + blockSizeZ / 2, 0, width / 2 - blockSizeZ / 2];
  let blockIndex = 1;
  blockXs.forEach((x) => {
    blockZs.forEach((z) => {
      const block = mesh(
        new THREE.BoxGeometry(blockSizeX, blockHeight, blockSizeZ),
        woodEnd,
        `Block ${blockIndex}`,
        root,
      );
      block.position.set(x, blockY, z);
      blockIndex += 1;
    });
  });

  const stringerCount = 3;
  for (let index = 0; index < stringerCount; index += 1) {
    const x = -length / 2 + blockSizeX / 2 + index * ((length - blockSizeX) / (stringerCount - 1));
    const stringer = mesh(
      new THREE.BoxGeometry(blockSizeX * 0.7, deckThickness * 0.7, width),
      woodDark,
      `Stringer ${index + 1}`,
      root,
    );
    stringer.position.set(x, deckTopY - deckThickness * 0.55, 0);
  }

  const references = {
    center: new THREE.Vector3(0, height / 2, 0),
    topSurface: new THREE.Vector3(0, height, 0),
    bottom: new THREE.Vector3(0, 0, 0),
  };

  return { root, references, height, length, width };
}
