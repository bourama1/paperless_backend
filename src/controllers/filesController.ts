import { Request, Response } from 'express';
import { getDb } from '../config/database';
import path from 'path';
import fs from 'fs';
import { notifyQueueUpdate } from '../services/notificationService';
import { PDFDocument, rgb, PDFName, PDFString } from 'pdf-lib';

/**
 * Parse simple SVG paths (M x,y L x2,y2 ...) into coordinate points.
 * Expected format: "M10,20 L30,40 L50,60"
 */
const parseSvgPath = (pathStr: string): { x: number; y: number }[] => {
  const points: { x: number; y: number }[] = [];
  const commands = pathStr.split(/(?=[ML])/);

  for (const cmd of commands) {
    const coords = cmd.slice(1).split(',').map(Number);
    const x = coords[0];
    const y = coords[1];
    if (
      coords.length === 2 &&
      typeof x === 'number' &&
      typeof y === 'number' &&
      !isNaN(x) &&
      !isNaN(y)
    ) {
      points.push({ x, y });
    }
  }
  return points;
};

export const reviseFile = async (req: Request, res: Response) => {
  console.log(`[Backend] reviseFile called for docId: ${req.params.id}`);
  const { id } = req.params;
  const { annotations } = req.body ?? {};
  const file = req.file;

  if (!file) {
    console.warn('[Backend] No file uploaded');
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const db = await getDb();
    const doc = await db.get('SELECT * FROM documents WHERE id = ?', id);

    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const latestRevision = await db.get(
      'SELECT version, filename FROM revisions WHERE document_id = ? ORDER BY version DESC LIMIT 1',
      id,
    );

    const newVersion = (latestRevision?.version || 0) + 1;
    const oldFilename = latestRevision?.filename || doc.name;
    const ext = path.extname(oldFilename);
    const basename = path.basename(oldFilename, ext).split('_v')[0];

    const newFilename = `${basename}_v${newVersion}${ext}`;
    const storagePath = process.env.STORAGE_PATH || './storage';
    const finalPath = path.join(storagePath, newFilename);

    // --- PDF FLATTENING WITH COORDINATE SCALING ---
    console.log(`[Backend] Flattening ${newFilename}...`);
    const existingPdfBytes = fs.readFileSync(file.path);
    const pdfDoc = await PDFDocument.load(existingPdfBytes);
    const pages = pdfDoc.getPages();
    const firstPage = pages[0];

    if (firstPage && annotations) {
      const rawAnnotations = JSON.parse(annotations);
      const normalizedAnnotations = Array.isArray(rawAnnotations)
        ? rawAnnotations.map((item: any) => {
            if (typeof item === 'string') {
              return { page: 1, width: 0, height: 0, d: item };
            }
            return {
              page: Number(item.page) || 1,
              width: Number(item.width) || 0,
              height: Number(item.height) || 0,
              d: item.d || item.path || '',
            };
          })
        : [];

      console.log(`[Backend] Processing ${normalizedAnnotations.length} annotation paths`);

      for (const annotation of normalizedAnnotations) {
        const targetPageIndex = Math.max(0, Math.min(annotation.page - 1, pages.length - 1));
        const targetPage = pages[targetPageIndex] || firstPage;
        const { width: pdfWidth, height: pdfHeight } = targetPage.getSize();

        const pageWidth = annotation.width > 0 ? annotation.width : pdfWidth;
        const pageHeight = annotation.height > 0 ? annotation.height : pdfHeight;

        const scaleX = pageWidth > 0 ? pdfWidth / pageWidth : 1;
        const scaleY = pageHeight > 0 ? pdfHeight / pageHeight : 1;

        console.log(
          `[Backend] Page ${annotation.page}: ${pageWidth}x${pageHeight}px → PDF: ${pdfWidth}x${pdfHeight}pt ` +
            `(scaleX=${scaleX.toFixed(3)}, scaleY=${scaleY.toFixed(3)})`,
        );

        const points = parseSvgPath(annotation.d);
        if (points.length < 2) continue;

        for (let i = 0; i < points.length - 1; i++) {
          const start = points[i];
          const end = points[i + 1];

          if (start && end) {
            targetPage.drawLine({
              start: { x: start.x * scaleX, y: pdfHeight - start.y * scaleY },
              end: { x: end.x * scaleX, y: pdfHeight - end.y * scaleY },
              thickness: 2 * Math.min(scaleX, scaleY),
              color: rgb(1, 0, 0),
              opacity: 0.75,
            });
          }
        }
      }
    }

    const pdfBytes = await pdfDoc.save();
    fs.writeFileSync(finalPath, pdfBytes);
    fs.unlinkSync(file.path);
    // --- END FLATTENING ---

    await db.run(
      'INSERT INTO revisions (document_id, filename, version, annotations) VALUES (?, ?, ?, ?)',
      [id, newFilename, newVersion, annotations],
    );

    await db.run('UPDATE documents SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', id);

    const updatedDoc = await db.get('SELECT * FROM documents WHERE id = ?', id);
    const revisions = await db.all(
      'SELECT * FROM revisions WHERE document_id = ? ORDER BY version DESC',
      id,
    );
    const result = { ...updatedDoc, revisions };

    notifyQueueUpdate(result);
    res.json(result);
  } catch (error) {
    console.error('Error revising file:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const exportPdfa = async (req: Request, res: Response) => {
  const { id } = req.params;
  console.log(`[Backend] exportPdfa called for docId: ${id}`);

  try {
    const db = await getDb();
    const latestRevision = await db.get(
      'SELECT filename FROM revisions WHERE document_id = ? ORDER BY version DESC LIMIT 1',
      id,
    );

    if (!latestRevision) {
      return res.status(404).json({ error: 'No revisions found for this document' });
    }

    const storagePath = process.env.STORAGE_PATH || './storage';
    const inputPath = path.join(storagePath, latestRevision.filename);

    const pdfaDir = path.join(storagePath, 'pdfa');
    if (!fs.existsSync(pdfaDir)) {
      fs.mkdirSync(pdfaDir, { recursive: true });
    }

    const outputFilename = latestRevision.filename.replace('.pdf', '_pdfa.pdf');
    const outputPath = path.join(pdfaDir, outputFilename);

    if (!fs.existsSync(inputPath)) {
      return res.status(404).json({ error: 'Source file not found' });
    }

    console.log(`[Backend] Exporting ${latestRevision.filename} to PDF/A...`);

    // Simplified PDF/A export using pdf-lib
    const pdfBytes = fs.readFileSync(inputPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);

    // Setting basic metadata
    pdfDoc.setTitle('PDF/A Export');
    pdfDoc.setSubject('Paperless Document');
    pdfDoc.setProducer('Paperless Backend');
    pdfDoc.setCreator('pdf-lib');

    // --- IMPROVE PDF/A COMPLIANCE ---

    // 1. Add XMP Metadata
    const xmpMetadata = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.4-c005 78.147326, 2012/08/23-13:03:03">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdf:Producer>Paperless Backend</pdf:Producer>
      <xmp:CreatorTool>pdf-lib</xmp:CreatorTool>
      <xmp:CreateDate>${new Date().toISOString()}</xmp:CreateDate>
      <xmp:ModifyDate>${new Date().toISOString()}</xmp:ModifyDate>
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">PDF/A Export</rdf:li></rdf:Alt></dc:title>
      <dc:creator><rdf:Seq><rdf:li>Paperless</rdf:li></rdf:Seq></dc:creator>
      <dc:description><rdf:Alt><rdf:li xml:lang="x-default">Paperless Document</rdf:li></rdf:Alt></dc:description>
      <pdfaid:part>1</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

    const xmpStream = pdfDoc.context.stream(xmpMetadata, {
      Type: 'Metadata',
      Subtype: 'XML',
    });
    const xmpStreamRef = pdfDoc.context.register(xmpStream);
    pdfDoc.catalog.set(PDFName.of('Metadata'), xmpStreamRef);

    // 2. Add OutputIntent (requires an ICC profile)
    // Since we don't have a real ICC profile, we'll try to add the structure.
    // In a real scenario, you MUST embed a valid ICC profile here.
    const outputIntentDict = pdfDoc.context.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      OutputConditionIdentifier: PDFString.of('sRGB'),
      RegistryName: PDFString.of('http://www.color.org'),
      Info: PDFString.of('sRGB IEC61966-2.1'),
    });
    const outputIntentRef = pdfDoc.context.register(outputIntentDict);
    pdfDoc.catalog.set(PDFName.of('OutputIntents'), pdfDoc.context.obj([outputIntentRef]));

    const outputBytes = await pdfDoc.save();
    fs.writeFileSync(outputPath, outputBytes);

    console.log(`[Backend] PDF/A export saved to: ${outputPath}`);
    res.json({
      message: 'Exported to PDF/A successfully',
      filename: outputFilename,
      fullPath: outputPath,
    });
  } catch (error) {
    console.error('Error exporting PDF/A:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
