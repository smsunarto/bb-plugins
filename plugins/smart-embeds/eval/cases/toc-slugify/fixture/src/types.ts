export type Heading = {
  level: number;
  text: string;
  anchor: string;
  line: number;
};

export type TocNode = {
  heading: Heading;
  children: TocNode[];
};

export type TocOptions = {
  minLevel: number;
  maxLevel: number;
  indent: string;
  ordered: boolean;
};

export type ScannedLine = {
  index: number;
  text: string;
};
