export type StringIdx = number & { __charIdx: true };

export type Row0Indexed = number & { __row0Indexed: true };

export type PositionString = {
  row: Row0Indexed;
  col: StringIdx;
};

export function calculateStringPosition(
  startPos: PositionString,
  content: string,
  indexInText: StringIdx,
): PositionString {
  let { row, col } = startPos;
  let currentIndex = 0 as StringIdx;

  while (currentIndex < indexInText) {
    if (content[currentIndex] == "\n") {
      row++;
      col = 0 as StringIdx;
    } else {
      col++;
    }
    currentIndex++;
  }

  return { row, col };
}
