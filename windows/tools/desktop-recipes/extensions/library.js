
// Appended to the original 1.3.0 Bot library module; D and V are its React and JSX
// runtime. The original adds files by dropping them; this button feeds the same intake.
function GrokLibraryUpload({ upload, disabled }) {
  const input = D.useRef(null);
  return (0, V.jsxs)('div', { style: { display: 'flex', justifyContent: 'flex-end' }, children: [
    (0, V.jsx)('input', { ref: input, type: 'file', multiple: true, hidden: true, onChange: event => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = '';
      if (files.length > 0) upload.ingest(files);
    } }),
    (0, V.jsx)(GrokButton, { disabled: disabled || upload.isUploading, onClick: () => input.current?.click(), size: 'md', type: 'button', variant: 'secondary',
      children: upload.isUploading ? grokText('正在上传…', 'Uploading…') : grokText('上传文件', 'Upload files') }),
  ] });
}
export { de as GrokLibraryFiles };
