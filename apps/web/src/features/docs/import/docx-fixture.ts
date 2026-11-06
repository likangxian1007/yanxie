import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  FootnoteReferenceRun,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalMergeType,
  WidthType,
  convertMillimetersToTwip,
} from 'docx';
import { tr } from '@/lib/i18n';

/**
 * 测试 / 演示用的“真实” Word 文档：中文标题、各种文字格式、多级编号、合并单元格的表格、图片、脚注、分页。
 * 用 docx 库（MIT）生成，导入测试和浏览器验收用的样例文件都出自这里。
 */

/** 64×48 的 PNG（一条下降的“损失曲线”） */
export const SAMPLE_PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAA6ElEQVR4nO3ZPQqFMBAEYA+Wg6X2nF5DBCsLQZYQ82eSncGFqV73IQ93xmU/Thnv1+AX8CwGMIABDKAL2JyjB0iDAaYD9uOUBkqANHADNudYAY+BGHAbuAH3fyB4M4AnDiAyvAJYDPFbiMjwesyxGFLXKIUhc07jG/J94DFgMooKDbKhtJHBGuoqJSCjuhNLAwKjpdRDGdpXCRDG11lFndFhFwoMkyXdhi0tRudlLsoYihk1LU6TjN1GE4xemHnjbhbTRlJYpwslhSrleb0BEwTu+wA9oFbFAUiEH+D9Sh3+J2AAA/wccAG7Df/L/923AAAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

export async function buildSampleDocx(): Promise<Blob> {
  const doc = new Document({
    title: tr('课题组季度研究报告'),
    creator: tr('研协'),
    styles: {
      default: {
        document: { run: { font: { ascii: 'Times New Roman', eastAsia: tr('宋体') }, size: 24 } },
      },
    },
    numbering: {
      config: [
        {
          reference: 'steps',
          levels: [
            { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT },
            {
              level: 1,
              format: LevelFormat.LOWER_LETTER,
              text: '%2)',
              alignment: AlignmentType.LEFT,
            },
          ],
        },
        {
          reference: 'cn',
          levels: [
            {
              level: 0,
              format: LevelFormat.CHINESE_COUNTING,
              text: tr('%1、'),
              alignment: AlignmentType.LEFT,
            },
          ],
        },
      ],
    },
    footnotes: {
      1: { children: [new Paragraph(tr('数据来源：2026 年第三季度实验记录。'))] },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: convertMillimetersToTwip(210), height: convertMillimetersToTwip(297) },
            margin: {
              top: convertMillimetersToTwip(25),
              bottom: convertMillimetersToTwip(25),
              left: convertMillimetersToTwip(30),
              right: convertMillimetersToTwip(30),
            },
          },
        },
        children: [
          new Paragraph({
            text: tr('课题组季度研究报告'),
            heading: HeadingLevel.HEADING_1,
            alignment: AlignmentType.CENTER,
          }),
          new Paragraph({ text: tr('一、研究背景'), heading: HeadingLevel.HEADING_2 }),
          new Paragraph({
            alignment: AlignmentType.JUSTIFIED,
            indent: { firstLine: 480 },
            spacing: { before: 120, after: 120, line: 360 },
            children: [
              new TextRun(tr('本季度围绕')),
              new TextRun({ text: tr('多模态大模型'), bold: true, color: 'C00000' }),
              new TextRun(tr('的高效微调展开，')),
              new TextRun({ text: tr('重点'), italics: true, underline: {} }),
              new TextRun({
                text: tr('评估了'),
                font: { ascii: 'Arial', eastAsia: tr('黑体') },
                size: 28,
              }),
              new TextRun({ text: tr('三种方法'), highlight: 'yellow' }),
              new TextRun(tr('。水的化学式为 H')),
              new TextRun({ text: '2', subScript: true }),
              new TextRun(tr('O，面积 m')),
              new TextRun({ text: '2', superScript: true }),
              new TextRun({ text: tr('，删除线'), strike: true }),
              new FootnoteReferenceRun(1),
              new TextRun({ text: tr('楷体文字'), font: tr('楷体'), color: '0070C0' }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun(tr('项目主页：')),
              new ExternalHyperlink({
                link: 'https://example.com/lab',
                children: [new TextRun({ text: tr('课题组网站'), style: 'Hyperlink' })],
              }),
            ],
          }),
          new Paragraph({ text: tr('二、实验步骤'), heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ text: tr('准备数据集'), numbering: { reference: 'steps', level: 0 } }),
          new Paragraph({ text: tr('清洗重复样本'), numbering: { reference: 'steps', level: 1 } }),
          new Paragraph({
            text: tr('划分训练集与测试集'),
            numbering: { reference: 'steps', level: 1 },
          }),
          new Paragraph({ text: tr('训练模型'), numbering: { reference: 'steps', level: 0 } }),
          new Paragraph({ text: tr('要点一：控制变量'), bullet: { level: 0 } }),
          new Paragraph({ text: tr('要点二：重复三次'), bullet: { level: 0 } }),
          new Paragraph({ text: tr('第一阶段'), numbering: { reference: 'cn', level: 0 } }),
          new Paragraph({ text: tr('三、实验结果'), heading: HeadingLevel.HEADING_2 }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                tableHeader: true,
                children: [
                  new TableCell({
                    children: [
                      new Paragraph({ children: [new TextRun({ text: tr('方法'), bold: true })] }),
                    ],
                    shading: { fill: 'D9E2F3', type: ShadingType.CLEAR, color: 'auto' },
                  }),
                  new TableCell({
                    columnSpan: 2,
                    children: [
                      new Paragraph({ children: [new TextRun({ text: tr('指标'), bold: true })] }),
                    ],
                    shading: { fill: 'D9E2F3', type: ShadingType.CLEAR, color: 'auto' },
                  }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({
                    children: [new Paragraph('LoRA')],
                    verticalMerge: VerticalMergeType.RESTART,
                  }),
                  new TableCell({ children: [new Paragraph(tr('准确率 91.2%'))] }),
                  new TableCell({ children: [new Paragraph(tr('显存 12 GB'))] }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [], verticalMerge: VerticalMergeType.CONTINUE }),
                  new TableCell({ children: [new Paragraph(tr('召回率 88.5%'))] }),
                  new TableCell({
                    children: [new Paragraph(tr('耗时 3 小时'))],
                    shading: { fill: 'FFF2CC', type: ShadingType.CLEAR, color: 'auto' },
                  }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph(tr('全量微调'))] }),
                  new TableCell({ children: [new Paragraph(tr('准确率 92.0%'))] }),
                  new TableCell({ children: [new Paragraph(tr('显存 80 GB'))] }),
                ],
              }),
            ],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new ImageRun({
                type: 'png',
                data: SAMPLE_PNG,
                transformation: { width: 240, height: 180 },
              }),
            ],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: tr('图 1：训练损失曲线'), size: 18, color: '595959' })],
          }),
          new Paragraph({ children: [new PageBreak()] }),
          new Paragraph({ text: tr('四、下一步计划'), heading: HeadingLevel.HEADING_2 }),
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun(tr('撰写人：张三'))],
          }),
        ],
      },
    ],
  });
  return Packer.toBlob(doc);
}
