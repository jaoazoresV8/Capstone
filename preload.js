const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  printReceiptToPdf: (fullPrintDocHtml) =>
    ipcRenderer.invoke("print-receipt-to-pdf", fullPrintDocHtml),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
});
