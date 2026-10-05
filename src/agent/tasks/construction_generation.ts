import {Vec3} from 'vec3';
import type { BlueprintData, BlueprintLevel } from './construction_tasks.js';


/**
 * Systematically builds the houses by placing them next to the already existing rooms. Still uses randomness for what gets placed next.
 * @param m width of the 3D space
 * @param n height of the 3D space
 * @param p depth of the 3D space
 * @param rooms Number of rooms to attempt to generate
 * @param minRoomWidth
 * @param minRoomLength
 * @param minRoomDepth
 * @param roomVariance How much the room size will vary
 * @param wrapping material of wrapping (air, glass, etc...) -> default is air
 * @param carpetStyle 0,1,2 increasingly more complex
 * @param windowStyle 0,1,2 increasingly more complex
 * @param complexity 0,1,2,3,4 for increasingly complex materials for room generation
 * @param startCoord an array of the x,y,z coordinates to create the blueprint. default = [148,-60,-170]
 * @returns a blueprint object
 */
export function proceduralGeneration(m: number = 20,
                                     n: number = 20,
                                     p: number = 20,
                                     rooms: number = 8,
                                     minRoomWidth: number = 5,
                                     minRoomLength: number = 5,
                                     minRoomDepth: number = 6,
                                     roomVariance: number = 5,
                                     wrapping: string = "air",
                                     carpetStyle: number = 1,
                                     windowStyle: number = 1,
                                     complexity: number = 4,
                                     startCoord: [number, number, number] = [148,-60,-170]): BlueprintData {
    // Build 3D space
    const matrix: string[][][] = Array.from({length: p}, () =>
        Array.from({length: m}, () =>
            Array(n).fill('air') as string[]
        )
    );

    // todo: extrapolate into another param? then have set materials be dynamic?
    let roomMaterials: string[] = ["stone", "terracotta", "quartz_block", "copper_block", "purpur_block"];

    if (complexity < roomMaterials.length) {
        roomMaterials = roomMaterials.slice(0, complexity + 1);
    }

    // Mark entire outer border with 'stone'
    for (let z = 0; z < p; z++) {
        for (let x = 0; x < m; x++) {
            for (let y = 0; y < n; y++) {
                if (
                    z === 0 || z === p - 1 || // Top and bottom faces
                    x === 0 || x === m - 1 || // Front and back faces
                    y === 0 || y === n - 1    // Left and right faces
                ) {
                    matrix[z][x][y] = 'stone';
                }
            }
        }
    }

    // Replace outer layer with wrap
    for (let z = 0; z < p; z++) {
        for (let x = 0; x < m; x++) {
            for (let y = 0; y < n; y++) {
                if (
                    (z === p - 1 || // Top face
                        x === 0 || x === m - 1 || // Front and back faces
                        y === 0 || y === n - 1) // Left and right faces
                ) {
                    matrix[z][x][y] = wrapping;
                }
            }
        }
    }

    let placedRooms = 0;
    let lastRoom: { x: number; y: number; z: number; length: number; width: number; depth: number } | null = null;

    // Direction probabilities (e.g., 'above': 40%, 'left': 15%, etc.)
    const directionChances: { direction: string; chance: number }[] = [
        {direction: 'above', chance: 0.15},
        {direction: 'left', chance: 0.15},
        {direction: 'right', chance: 0.15},
        {direction: 'forward', chance: 0.15},
        {direction: 'backward', chance: 0.15},
    ];

    // Function to pick a random direction based on percentages
    function getRandomDirection(): string {
        const rand: number = Math.random();
        let cumulative = 0;

        for (const {direction, chance} of directionChances) {
            cumulative += chance;
            if (rand <= cumulative) return direction;
        }
        return directionChances[1].direction; // Fallback to the first direction
    }

    // Ensures no rooms overlap except at edges
    function isSpaceValid(newX: number, newY: number, newZ: number, newLength: number, newWidth: number, newDepth: number): boolean {
        for (let di = 0; di < newDepth; di++) {
            for (let dj = 0; dj < newLength; dj++) {
                for (let dk = 0; dk < newWidth; dk++) {
                    const x: number = newX + dj;
                    const y: number = newY + dk;
                    const z: number = newZ + di;

                    // Skip checking the outermost borders of the new room (these can overlap with stone)
                    if (dj === 0 || dj === newLength - 1 ||
                        dk === 0 || dk === newWidth - 1 ||
                        di === 0 || di === newDepth - 1) {
                        continue;
                    }

                    // For non-border spaces, ensure they're air
                    if (matrix[z][x][y] !== 'air') {
                        return false;
                    }
                }
            }
        }
        return true;
    }

    function validateAndBuildBorder(matrix: string[][][], newX: number, newY: number, newZ: number, newLength: number, newWidth: number, newDepth: number, m: number, n: number, p: number, material: string): boolean {
        // Allow rooms to use the matrix edges (note the <= instead of <)
        if (
            newX >= 0 && newX + newLength <= m &&
            newY >= 0 && newY + newWidth <= n &&
            newZ >= 0 && newZ + newDepth <= p &&
            isSpaceValid(newX, newY, newZ, newLength, newWidth, newDepth)
        ) {
            // console.log(`Placing room at (${newX}, ${newY}, ${newZ}) with dimensions (${newLength}x${newWidth}x${newDepth})`);
            for (let di = 0; di < newDepth; di++) {
                for (let dj = 0; dj < newLength; dj++) {
                    for (let dk = 0; dk < newWidth; dk++) {
                        const x: number = newX + dj;
                        const y: number = newY + dk;
                        const z: number = newZ + di;

                        // If this is at a matrix border, don't modify it
                        if (z === 0) {
                            continue;
                        }
                        // if (x === 0 || x === m - 1 ||
                        //     y === 0 || y === n - 1 ||
                        //     z === 0 || z === p - 1) {
                        //     continue;
                        // }

                        // For non-border spaces, check if this is a floor that should be shared
                        //was: === 'stone'
                        if (di === 0 && matrix[z - 1][x][y] !== 'air') {
                            // Skip creating floor if there's a ceiling below
                            matrix[z][x][y] = 'air';
                        } else if (di === 0 || di === newDepth - 1 ||
                            dj === 0 || dj === newLength - 1 ||
                            dk === 0 || dk === newWidth - 1) {
                            matrix[z][x][y] = material;
                        } else {
                            matrix[z][x][y] = 'air';
                        }


                    }
                }
            }
            return true;
        }
        return false;
    }

    function addDoor(matrix: string[][][], x: number, y: number, z: number, material: string): void {
        void material;
        matrix[z][x][y] = material;

        // Place the lower half of the door
        // matrix[z + 1][x][y] = 'dark_oak_door[half=lower, hinge=left]';

        matrix[z + 1][x][y] = 'dark_oak_door';


        // Place the upper half of the door
        // matrix[z + 2][x][y] = 'dark_oak_door[half=upper, hinge=left]';
        matrix[z + 2][x][y] = 'dark_oak_door';


    }


    // Takes in a room and randomly converts some faces to be windows
    function addWindowsAsSquares(matrix: string[][][], x: number, y: number, z: number, newLength: number, newWidth: number, newDepth: number, material: string): void {
        // Matrix dimensions
        const matrixDepth: number = matrix.length;
        const matrixLength: number = matrix[0].length;
        const matrixWidth: number = matrix[0][0].length;
        const windowX: number = Math.ceil(minRoomWidth / 2);
        const windowY: number = Math.ceil(minRoomLength / 2);
        const windowZ: number = Math.ceil(minRoomDepth / 2);

        // Helper function to check if coordinates are within bounds
        function isInBounds(z: number, x: number, y: number): boolean {
            return z >= 0 && z < matrixDepth &&
                x >= 0 && x < matrixLength &&
                y >= 0 && y < matrixWidth;
        }

        // Front and back faces (z is constant)
        if (Math.random() < 0.8) {
            const centerX: number = x + Math.floor(newLength / 2 - windowX / 2);
            const centerY: number = y + Math.floor(newWidth / 2 - windowY / 2);

            for (let dx = 0; dx <= windowX; dx++) {
                for (let dy = 0; dy <= windowY; dy++) {
                    const frontZ: number = z;
                    const backZ: number = z + newDepth - 1;

                    if (isInBounds(frontZ, centerX + dx, centerY + dy) &&
                        matrix[frontZ][centerX + dx][centerY + dy] === material) {
                        matrix[frontZ][centerX + dx][centerY + dy] = 'glass';
                    }
                    if (isInBounds(backZ, centerX + dx, centerY + dy) &&
                        matrix[backZ][centerX + dx][centerY + dy] === material) {
                        matrix[backZ][centerX + dx][centerY + dy] = 'glass';
                    }
                }
            }
        }

        // Left and right faces (x is constant)
        if (Math.random() < 0.8) {
            const centerZ: number = z + Math.floor(newDepth / 2 - windowZ / 2);
            const centerY: number = y + Math.floor(newWidth / 2 - windowY / 2);

            for (let dz = 0; dz <= windowZ; dz++) {
                for (let dy = 0; dy <= windowY; dy++) {
                    const leftX: number = x;
                    const rightX: number = x + newLength - 1;

                    if (isInBounds(centerZ + dz, leftX, centerY + dy) &&
                        matrix[centerZ + dz][leftX][centerY + dy] === material) {
                        matrix[centerZ + dz][leftX][centerY + dy] = 'glass';
                    }
                    if (isInBounds(centerZ + dz, rightX, centerY + dy) &&
                        matrix[centerZ + dz][rightX][centerY + dy] === material) {
                        matrix[centerZ + dz][rightX][centerY + dy] = 'glass';
                    }
                }
            }
        }

        // Top and bottom faces (y is constant)
        if (Math.random() < 0.8) {
            const centerX: number = x + Math.floor(newLength / 2 - windowX / 2);
            const centerZ: number = z + Math.floor(newDepth / 2 - windowZ / 2);

            for (let dx = 0; dx <= windowX; dx++) {
                for (let dz = 0; dz <= windowZ; dz++) {
                    const bottomY: number = y;
                    const topY: number = y + newWidth - 1;

                    if (isInBounds(centerZ + dz, centerX + dx, bottomY) &&
                        matrix[centerZ + dz][centerX + dx][bottomY] === material) {
                        matrix[centerZ + dz][centerX + dx][bottomY] = 'glass';
                    }
                    if (isInBounds(centerZ + dz, centerX + dx, topY) &&
                        matrix[centerZ + dz][centerX + dx][topY] === material) {
                        matrix[centerZ + dz][centerX + dx][topY] = 'glass';
                    }
                }
            }
        }
    }

    function addWindowsAsPlane(matrix: string[][][], x: number, y: number, z: number, newLength: number, newWidth: number, newDepth: number, material: string): void {
        // Ensure the new dimensions are within bounds
        const maxX: number = matrix[0].length;
        const maxY: number = matrix[0][0].length;
        const maxZ: number = matrix.length;

        // Each face has a 30% chance of becoming a window
        if (Math.random() < 0.8) {
            for (let dx = 0; dx < newLength; dx++) {
                for (let dy = 0; dy < newWidth; dy++) {
                    const frontZ: number = z;
                    const backZ: number = z + newDepth - 1;

                    // Check bounds before modifying the matrix
                    if (frontZ >= 0 && frontZ < maxZ && x + dx >= 0 && x + dx < maxX && y + dy >= 0 && y + dy < maxY) {
                        if (matrix[frontZ][x + dx][y + dy] === material) {
                            matrix[frontZ][x + dx][y + dy] = 'glass';
                        }
                    }
                    if (backZ >= 0 && backZ < maxZ && x + dx >= 0 && x + dx < maxX && y + dy >= 0 && y + dy < maxY) {
                        if (matrix[backZ][x + dx][y + dy] === material) {
                            matrix[backZ][x + dx][y + dy] = 'glass';
                        }
                    }
                }
            }
        }

        if (Math.random() < 0.8) {
            for (let dz = 0; dz < newDepth; dz++) {
                for (let dy = 0; dy < newWidth; dy++) {
                    const leftX: number = x;
                    const rightX: number = x + newLength - 1;

                    // Check bounds before modifying the matrix
                    if (leftX >= 0 && leftX < maxX && z + dz >= 0 && z + dz < maxZ && y + dy >= 0 && y + dy < maxY) {
                        if (matrix[z + dz][leftX][y + dy] === material) {
                            matrix[z + dz][leftX][y + dy] = 'glass';
                        }
                    }
                    if (rightX >= 0 && rightX < maxX && z + dz >= 0 && z + dz < maxZ && y + dy >= 0 && y + dy < maxY) {
                        if (matrix[z + dz][rightX][y + dy] === material) {
                            matrix[z + dz][rightX][y + dy] = 'glass';
                        }
                    }
                }
            }
        }
    }


    //still a little buggy
    function addStairs(matrix: string[][][], x: number, y: number, z: number, length: number, width: number, material: string): void {
        let currentZ: number = z;
        let currentX: number = x + 1;
        let currentY: number = y + 1;
        let direction = 0;
        let stepCount = 0;
        const maxSteps: number = length * width; // Safety limit

        while (currentZ >= 0 && currentX < x + length - 1 && currentY < y + width - 1 && stepCount < maxSteps) {
            // Place stair block
            matrix[currentZ][currentX][currentY] = material || 'stone';

            // Clear 3 blocks above for headroom
            for (let i = 1; i <= 3; i++) {
                if (currentZ + i < matrix.length) {
                    matrix[currentZ + i][currentX][currentY] = 'air';
                }
            }

            // Move to next position based on direction
            if (direction === 0) {
                currentX++;
                if (currentX >= x + length - 1) {
                    currentX = x + length - 2;
                    direction = 1;
                } else {
                    currentZ--;
                }
            } else {
                currentY++;
                if (currentY >= y + width - 1) {
                    currentY = y + width - 2;
                    direction = 0;
                } else {
                    currentZ--;
                }
            }

            stepCount++;
        }
    }

    function addCarpet(probability: number, matrix: string[][][], newX: number, newY: number, newZ: number, newLength: number, newWidth: number, material: string): void {
        const colors: string[] = ["blue", "cyan", "light_blue", "lime"];

        // Iterate through the dimensions of the room
        for (let dx = 1; dx < newLength - 1; dx++) {
            for (let dy = 1; dy < newWidth - 1; dy++) {
                const x: number = newX + dx;
                const y: number = newY + dy;
                const z: number = newZ; // Start at floor level

                // Check if there is floor (not air)
                if (matrix[z][x][y] === material) {
                    // Consider a random probability of adding a carpet
                    if (Math.random() < probability) {
                        // Choose a random color for the carpet
                        const randomColor: string = colors[Math.floor(Math.random() * colors.length)] as string;
                        // Add carpet one z position above the floor with a random color
                        matrix[z + 1][x][y] = `${randomColor}_carpet`;
                    }
                }
            }
        }
    }

    function addLadder(matrix: string[][][], x: number, y: number, z: number): void {
        let currentZ: number = z + 1;

        // turn the floor into air where person would go up
        matrix[currentZ][x + 1][y] = 'air';

        // Build the first 3 ladder segments from floor level downwards
        for (let i = 0; i < 3; i++) {
            // Place stone block behind ladder
            matrix[currentZ][x - 1][y] = 'stone';
            // Place ladder
            matrix[currentZ][x][y] = 'ladder[facing=north]';
            currentZ -= 1;
        }

        // Continue building ladder downwards until a floor is hit or we reach the bottom
        while (currentZ >= 0 && matrix[currentZ][x][y] === 'air') {
            // Place stone block behind ladder
            matrix[currentZ][x - 1][y] = 'stone';
            // Place ladder
            matrix[currentZ][x][y] = 'ladder[facing=north]';

            // Move down
            currentZ--;
        }
    }
    void addLadder;


    function embellishments(carpet: number, windowStyle: number, matrix: string[][][], newX: number, newY: number, newZ: number, newLength: number, newWidth: number, newDepth: number, material: string): void {


        switch (windowStyle) {
            case 0:
                break;
            case 1:
                addWindowsAsSquares(matrix, newZ, newY, newZ, newLength, newWidth, newDepth, material);
                break;
            case 2:
                addWindowsAsPlane(matrix, newZ, newY, newZ, newLength, newWidth, newDepth, material);
                break;
        }


        switch (carpet) {
            case 0:
                break;
            case 1:
                addCarpet(0.3, matrix, newX, newY, newZ, newLength, newWidth, material);
                break;
            case 2:
                addCarpet(0.7, matrix, newX, newY, newZ, newLength, newWidth, material);
                break;
        }


    }


    // Places rooms until we can't, or we place all
    // attempts random configurations of rooms in random directions.
    while (placedRooms < rooms) {
        let roomPlaced = false;

        for (let attempt = 0; attempt < 150; attempt++) {

            const material: string = roomMaterials[Math.floor(Math.random() * roomMaterials.length)] as string;


            // dimensions of room
            const newLength: number = Math.max(minRoomLength, Math.floor(Math.random() * roomVariance) + minRoomLength);
            const newWidth: number = Math.max(minRoomWidth, Math.floor(Math.random() * roomVariance) + minRoomWidth);
            const newDepth: number = Math.max(minRoomDepth, Math.floor(Math.random() * Math.floor(roomVariance / 2)) + minRoomDepth);
            let newX: number, newY: number, newZ: number;

            // first room is special
            if (placedRooms === 0) {
                // First room placement
                newX = Math.floor(Math.random() * (m - newLength - 1)) + 1;
                newY = Math.floor(Math.random() * (n - newWidth - 1)) + 1;
                newZ = 0; // Ground floor

                if (validateAndBuildBorder(matrix, newX, newY, newZ, newLength, newWidth, newDepth, m, n, p, material)) {
                    lastRoom = {x: newX, y: newY, z: newZ, length: newLength, width: newWidth, depth: newDepth};
                    roomPlaced = true;
                    placedRooms++;

                    // Add doors to all four sides
                    // Left side
                    addDoor(matrix, newX, newY + Math.floor(newWidth / 2), newZ, material);
                    // Right side
                    addDoor(matrix, newX + newLength - 1, newY + Math.floor(newWidth / 2), newZ, material);
                    // Front side
                    addDoor(matrix, newX + Math.floor(newLength / 2), newY, newZ, material);
                    // Back side
                    addDoor(matrix, newX + Math.floor(newLength / 2), newY + newWidth - 1, newZ, material);

                    addCarpet(0.7, matrix, newX, newY, newZ, newLength, newWidth, material);
                }

                break;
            } else {
                const direction: string = getRandomDirection();

                switch (direction) {
                    case 'above':
                        newX = (lastRoom as NonNullable<typeof lastRoom>).x;
                        newY = (lastRoom as NonNullable<typeof lastRoom>).y;
                        newZ = (lastRoom as NonNullable<typeof lastRoom>).z + (lastRoom as NonNullable<typeof lastRoom>).depth - 1;
                        if (validateAndBuildBorder(matrix, newX, newY, newZ, newLength, newWidth, newDepth, m, n, p, material)) {

                            embellishments(carpetStyle, windowStyle, matrix, newX, newY, newZ, newLength, newWidth, newDepth, material);

                            // addLadder(matrix, lastRoom.x + Math.floor(lastRoom.length / 2),
                            //     lastRoom.y + Math.floor(lastRoom.width / 2),
                            //     newZ); // Adding the ladder

                            addStairs(matrix, newX, newY, newZ, newLength, newWidth, material);


                            lastRoom = {x: newX, y: newY, z: newZ, length: newLength, width: newWidth, depth: newDepth};
                            roomPlaced = true;
                            placedRooms++;
                            break;
                        }
                        break;

                    case 'left':
                        newX = (lastRoom as NonNullable<typeof lastRoom>).x - newLength + 1;
                        newY = (lastRoom as NonNullable<typeof lastRoom>).y;
                        newZ = (lastRoom as NonNullable<typeof lastRoom>).z;
                        if (validateAndBuildBorder(matrix, newX, newY, newZ, newLength, newWidth, newDepth, m, n, p, material)) {


                            embellishments(carpetStyle, windowStyle, matrix, newX, newY, newZ, newLength, newWidth, newDepth, material);


                            addDoor(matrix, (lastRoom as NonNullable<typeof lastRoom>).x, (lastRoom as NonNullable<typeof lastRoom>).y + Math.floor((lastRoom as NonNullable<typeof lastRoom>).width / 2), (lastRoom as NonNullable<typeof lastRoom>).z, material);


                            lastRoom = {x: newX, y: newY, z: newZ, length: newLength, width: newWidth, depth: newDepth};
                            roomPlaced = true;
                            placedRooms++;
                            break;
                        }
                        break;

                    case 'right':
                        newX = (lastRoom as NonNullable<typeof lastRoom>).x + (lastRoom as NonNullable<typeof lastRoom>).length - 1;
                        newY = (lastRoom as NonNullable<typeof lastRoom>).y;
                        newZ = (lastRoom as NonNullable<typeof lastRoom>).z;
                        if (validateAndBuildBorder(matrix, newX, newY, newZ, newLength, newWidth, newDepth, m, n, p, material)) {

                            embellishments(carpetStyle, windowStyle, matrix, newX, newY, newZ, newLength, newWidth, newDepth, material);


                            addDoor(matrix, (lastRoom as NonNullable<typeof lastRoom>).x + (lastRoom as NonNullable<typeof lastRoom>).length - 1,
                                (lastRoom as NonNullable<typeof lastRoom>).y + Math.floor((lastRoom as NonNullable<typeof lastRoom>).width / 2),
                                (lastRoom as NonNullable<typeof lastRoom>).z, material);


                            lastRoom = {x: newX, y: newY, z: newZ, length: newLength, width: newWidth, depth: newDepth};
                            roomPlaced = true;
                            placedRooms++;
                            break;
                        }
                        break;

                    case 'forward':
                        newX = (lastRoom as NonNullable<typeof lastRoom>).x;
                        newY = (lastRoom as NonNullable<typeof lastRoom>).y + (lastRoom as NonNullable<typeof lastRoom>).width - 1;
                        newZ = (lastRoom as NonNullable<typeof lastRoom>).z;
                        if (validateAndBuildBorder(matrix, newX, newY, newZ, newLength, newWidth, newDepth, m, n, p, material)) {

                            embellishments(carpetStyle, windowStyle, matrix, newX, newY, newZ, newLength, newWidth, newDepth, material);


                            addDoor(matrix, (lastRoom as NonNullable<typeof lastRoom>).x + Math.floor((lastRoom as NonNullable<typeof lastRoom>).length / 2),
                                (lastRoom as NonNullable<typeof lastRoom>).y + (lastRoom as NonNullable<typeof lastRoom>).width - 1,
                                (lastRoom as NonNullable<typeof lastRoom>).z, material);


                            lastRoom = {x: newX, y: newY, z: newZ, length: newLength, width: newWidth, depth: newDepth};
                            roomPlaced = true;
                            placedRooms++;
                            break;
                        }
                        break;

                    case 'backward':
                        newX = (lastRoom as NonNullable<typeof lastRoom>).x;
                        newY = (lastRoom as NonNullable<typeof lastRoom>).y - newWidth + 1;
                        newZ = (lastRoom as NonNullable<typeof lastRoom>).z;
                        if (validateAndBuildBorder(matrix, newX, newY, newZ, newLength, newWidth, newDepth, m, n, p, material)) {

                            embellishments(carpetStyle, windowStyle, matrix, newX, newY, newZ, newLength, newWidth, newDepth, material);


                            addDoor(matrix, (lastRoom as NonNullable<typeof lastRoom>).x + Math.floor((lastRoom as NonNullable<typeof lastRoom>).length / 2),
                                (lastRoom as NonNullable<typeof lastRoom>).y,
                                (lastRoom as NonNullable<typeof lastRoom>).z, material);


                            lastRoom = {x: newX, y: newY, z: newZ, length: newLength, width: newWidth, depth: newDepth};
                            roomPlaced = true;
                            placedRooms++;
                            break;
                        }
                        break;
                }

                if (roomPlaced) {
                    break;
                }
            }
        }

        if (!roomPlaced) {
            console.warn(`Could not place room ${placedRooms + 1}`);
            break;
        }
    }

    // uncomment to visualize blueprint output
    // printMatrix(matrix)

    return matrixToBlueprint(matrix, startCoord);
}




/**
 * for cutesy output
 * @param matrix
 */
function printMatrix(matrix: string[][][]): void {
    matrix.forEach((layer: string[][], layerIndex: number) => {
        console.log(`Layer ${layerIndex}:`);
        layer.forEach((row: string[]) => {
            console.log(
                row.map((cell: string) => {
                    switch (cell) {
                        case 'stone': return '█';  // Wall
                        case 'air': return '.';    // Open space
                        case 'dark_oak_door[half=upper, hinge=left]': return 'D';
                        case 'dark_oak_door[half=lower, hinge=left]': return 'D';
                        case 'oak_stairs[facing=north]': return 'S';  // Stairs
                        case 'oak_stairs[facing=east]': return 'S';  // Stairs
                        case 'oak_stairs[facing=south]': return 'S';  // Stairs
                        case 'oak_stairs[facing=west]': return 'S';  // Stairs
                        case 'glass': return 'W';


                        default: return '?';       // Unknown or unmarked space
                    }
                }).join(' ')
            );
        });
        console.log('---');
    });
}
void printMatrix;

/**
 * Converts a 3D matrix into a Minecraft blueprint format
 * @param {Array<Array<Array<string>>>} matrix - 3D matrix of block types
 * @param {number[]} startCoord - Starting coordinates [x, y, z]
 * @returns {Object} a Blueprint object in Minecraft format
 */
/** Pure helper, exported for unit tests. */
export function matrixToBlueprint(matrix: string[][][], startCoord: [number, number, number]): BlueprintData {
    // Validate inputs
    if (!Array.isArray(matrix) || !Array.isArray(startCoord) || startCoord.length !== 3) {
        console.log(matrix);
        throw new Error('Invalid input format');
    }

    const [startX, startY, startZ] = startCoord;


    // CONSIDER: using blueprint class here?
    return {
        levels: matrix.map((level: string[][], levelIndex: number) => ({
            level: levelIndex,
            coordinates: [
                startX,
                startY + levelIndex,
                startZ
            ] as [number, number, number],
            placement: level.map((row: string[]) =>
                // Ensure each block is a string, default to 'air' if undefined
                row.map((block: string) => block?.toString() || 'air')
            )
        }))
    };
}

/** Pure helper, exported for unit tests. */
// eslint-disable-next-line require-await -- task helper API is promise-based
export async function getBlockName(bot: any, coordinate: { x: number; y: number; z: number }): Promise<string> {
    const blockAtLocation: any = bot.blockAt(new (Vec3 as any)(coordinate.x, coordinate.y, coordinate.z));
    return blockAtLocation ? bot.registry.blocks[blockAtLocation.type].name : "air";
}

/**
 * Converts a world location to a blueprint. takes some time to ensure that the chunks are loaded before conversion.
 * @param startCoord - [x,y,z] that signifies the start of the blueprint
 * @param y_amount - how many spaces you want to register from the start coordinate in the y dimension
 * @param x_amount - how many spaces in the x direction on minecraft
 * @param z_amount - how many spaces from the start coordinate in the z direction in minecraft
 * @param bot - the mineflayer agent (ex. andy)
 * @returns - a Blueprint object of the converted blueprint
 */
export async function worldToBlueprint(startCoord: { x: number; y: number; z: number }, y_amount: number, x_amount: number, z_amount: number, bot: any): Promise<BlueprintData & { materials: Record<string, number> }> {
    await bot.waitForChunksToLoad();

    const materials: Record<string, number> = {};

    const levels: BlueprintLevel[] = [];
    for (let y = 0; y < y_amount; y++) {
        const placement: string[][] = [];
        const coordinates: [number, number, number] = [startCoord.x, startCoord.y + y, startCoord.z];
        for (let z = 0; z < z_amount; z++) {
            const row: string[] = [];
            for (let x = 0; x < x_amount; x++) {
                const worldCoord = {
                    x: startCoord.x + x,
                    y: startCoord.y + y,
                    z: startCoord.z + z
                };
                await bot.waitForChunksToLoad(worldCoord);
                const blockName: string = await getBlockName(bot, worldCoord);
                row.push(blockName);
                if (blockName !== 'air') {
                    materials[blockName] = (materials[blockName] || 0) + 1;
                }
            }
            placement.push(row);
        }
        levels.push({
            level: y,
            coordinates: coordinates,
            placement: placement
        });
    }
    console.log(levels);
    const blueprint_data: BlueprintData & { materials: Record<string, number> } = {
        materials: materials,
        levels: levels
    };
    return blueprint_data;
}

export function blueprintToTask(blueprint_data: BlueprintData & { materials: Record<string, number> }, num_agents: number): Record<string, unknown> {
    const initialInventory: Record<string, Record<string, number>> = {};
    for (let j = 0; j < num_agents; j++) {
        initialInventory[JSON.stringify(j)] = {"diamond_pickaxe": 1, "diamond_axe": 1, "diamond_shovel": 1};
    }

    let give_agent = 0;
    console.log("materials", blueprint_data.materials);
    for (const key of Object.keys(blueprint_data.materials)) {
        (initialInventory[JSON.stringify(give_agent)] as Record<string, number>)[key] = blueprint_data.materials[key] as number;
        give_agent = (give_agent + 1) % num_agents;
    }

    const task: Record<string, unknown> = {
        type: "construction",
        goal: "Make a structure with the blueprint below",
        conversation: "Let's share materials and make a structure with the blueprint",
        agent_count: num_agents,
        blueprint: blueprint_data,
        initial_inventory: initialInventory,
    };
    return task;
}