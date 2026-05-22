export type JsonCanvasNodeType = 'text' | 'file' | 'link' | 'group';
export type JsonCanvasSide = 'top' | 'right' | 'bottom' | 'left';
export type JsonCanvasEnd = 'none' | 'arrow';

export interface JsonCanvasDocument {
  nodes?: JsonCanvasNode[];
  edges?: JsonCanvasEdge[];
  [key: string]: unknown;
}

export interface JsonCanvasBaseNode {
  id: string;
  type: JsonCanvasNodeType | string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  [key: string]: unknown;
}

export interface JsonCanvasTextNode extends JsonCanvasBaseNode {
  type: 'text';
  text: string;
}

export interface JsonCanvasFileNode extends JsonCanvasBaseNode {
  type: 'file';
  file: string;
  subpath?: string;
}

export interface JsonCanvasLinkNode extends JsonCanvasBaseNode {
  type: 'link';
  url: string;
}

export interface JsonCanvasGroupNode extends JsonCanvasBaseNode {
  type: 'group';
  label?: string;
  background?: string;
  backgroundStyle?: 'cover' | 'ratio' | 'repeat' | string;
}

export type JsonCanvasNode =
  | JsonCanvasTextNode
  | JsonCanvasFileNode
  | JsonCanvasLinkNode
  | JsonCanvasGroupNode
  | JsonCanvasBaseNode;

export interface JsonCanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: JsonCanvasSide;
  fromEnd?: JsonCanvasEnd;
  toNode: string;
  toSide?: JsonCanvasSide;
  toEnd?: JsonCanvasEnd;
  color?: string;
  label?: string;
  [key: string]: unknown;
}
