import { API_VERSION } from '@nec/contracts';
import { Button, FormWindow } from '@nec/ui';

export function AboutForm({ onClose }: { onClose: () => void }) {
  return (
    <FormWindow title="About NEC ERP" onClose={onClose} width={420} footerLeft={<Button variant="primary" onClick={onClose}>OK</Button>}>
      <p>
        <strong>NEC ERP</strong> desktop client 0.1.0
      </p>
      <p className="ui-muted">API version {API_VERSION}. Independent product; not affiliated with any other ERP vendor.</p>
    </FormWindow>
  );
}
