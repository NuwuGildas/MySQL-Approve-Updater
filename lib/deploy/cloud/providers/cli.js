'use strict';
/* CLI-backed providers: AWS EC2 (aws), Google Compute Engine (gcloud) and
   Azure (az). They rely on the CLI already being installed and logged in on
   this machine; The Ascension only composes the commands. Region/size/image
   are free-text ids (no listing), with sensible defaults. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { capture, probeTool } = require('../../exec');
const { qLocal: q } = require('../../shell');

const tmpFile = (name, data) => { const p = path.join(os.tmpdir(), `ascension-${name}-${Date.now()}`); fs.writeFileSync(p, data, { mode: 0o600 }); return p; };

const aws = {
  id: 'aws', label: 'AWS EC2 (aws CLI)', auth: 'cli', cli: 'aws', tokenHint: 'Uses the aws CLI credentials/profile of this machine (set AWS_PROFILE in .env if needed)',
  defaults: { region: 'eu-west-1', size: 't3.micro', image: 'resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id' },
  async available() { return !!(await probeTool('aws', '--version')); },
  async ensureKey(_t, publicKey, name) {
    const keyName = `ascension-${name}`;
    try { await capture(`aws ec2 describe-key-pairs --key-names ${q(keyName)} --output json`, { timeoutMs: 60000 }); return keyName; } catch {}
    const f = tmpFile('pub', publicKey);
    try { await capture(`aws ec2 import-key-pair --key-name ${q(keyName)} --public-key-material fileb://${q(f)} --output json`, { timeoutMs: 60000 }); } finally { fs.unlinkSync(f); }
    return keyName;
  },
  async create(_t, spec) {
    const keyName = await this.ensureKey(null, spec.publicKey, spec.name);
    const ud = tmpFile('userdata', spec.userData);
    try {
      let sg = '';
      try {
        const sgOut = await capture(`aws ec2 describe-security-groups --group-names ascension-web --output json --region ${q(spec.region)}`, { timeoutMs: 60000 });
        sg = JSON.parse(sgOut).SecurityGroups[0].GroupId;
      } catch {
        const created = JSON.parse(await capture(`aws ec2 create-security-group --group-name ascension-web --description "The Ascension web servers" --output json --region ${q(spec.region)}`, { timeoutMs: 60000 }));
        sg = created.GroupId;
        for (const port of [22, 80, 443]) await capture(`aws ec2 authorize-security-group-ingress --group-id ${sg} --protocol tcp --port ${port} --cidr 0.0.0.0/0 --region ${q(spec.region)}`, { timeoutMs: 60000 });
      }
      const out = JSON.parse(await capture(`aws ec2 run-instances --image-id ${q(spec.image)} --instance-type ${q(spec.size)} --key-name ${q(keyName)} --security-group-ids ${sg} --user-data file://${q(ud)} --tag-specifications ${q(`ResourceType=instance,Tags=[{Key=Name,Value=${spec.name}},{Key=ascension,Value=true}]`)} --output json --region ${q(spec.region)}`, { timeoutMs: 120000 }));
      return { id: out.Instances[0].InstanceId, name: spec.name };
    } finally { fs.unlinkSync(ud); }
  },
  async status(_t, id, spec) {
    const out = JSON.parse(await capture(`aws ec2 describe-instances --instance-ids ${q(id)} --output json --region ${q(spec.region)}`, { timeoutMs: 60000 }));
    const inst = out.Reservations?.[0]?.Instances?.[0];
    const state = inst?.State?.Name; const ip = inst?.PublicIpAddress || null;
    return { status: state === 'running' && ip ? 'ready' : state === 'pending' ? 'creating' : state || 'unknown', ip, raw: state };
  },
  async destroy(_t, id, spec) { await capture(`aws ec2 terminate-instances --instance-ids ${q(id)} --region ${q(spec.region)} --output json`, { timeoutMs: 60000 }); },
  defaultUser: 'ubuntu',
  console: (id, spec) => `https://${spec.region}.console.aws.amazon.com/ec2/home?region=${spec.region}#InstanceDetails:instanceId=${id}`,
};

const gcp = {
  id: 'gcp', label: 'Google Compute Engine (gcloud)', auth: 'cli', cli: 'gcloud', tokenHint: 'Uses the active gcloud account and project of this machine',
  defaults: { region: 'europe-west1-b', size: 'e2-small', image: 'ubuntu-2404-lts-amd64' },
  async available() { return !!(await probeTool('gcloud', '--version')); },
  async create(_t, spec) {
    const ud = tmpFile('userdata', spec.userData);
    const pub = tmpFile('sshkeys', `deploy:${spec.publicKey}\n`);
    try {
      const out = JSON.parse(await capture(`gcloud compute instances create ${q(spec.name)} --zone ${q(spec.region)} --machine-type ${q(spec.size)} --image-family ${q(spec.image)} --image-project ubuntu-os-cloud --metadata-from-file user-data=${q(ud)},ssh-keys=${q(pub)} --tags http-server,https-server --labels ascension=true --format json`, { timeoutMs: 180000 }));
      return { id: out[0]?.name || spec.name, name: spec.name };
    } finally { fs.unlinkSync(ud); fs.unlinkSync(pub); }
  },
  async status(_t, id, spec) {
    const out = JSON.parse(await capture(`gcloud compute instances describe ${q(id)} --zone ${q(spec.region)} --format json`, { timeoutMs: 60000 }));
    const ip = out.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP || null;
    return { status: out.status === 'RUNNING' && ip ? 'ready' : ['PROVISIONING', 'STAGING'].includes(out.status) ? 'creating' : String(out.status || 'unknown').toLowerCase(), ip, raw: out.status };
  },
  async destroy(_t, id, spec) { await capture(`gcloud compute instances delete ${q(id)} --zone ${q(spec.region)} --quiet`, { timeoutMs: 180000 }); },
  console: (id, spec) => `https://console.cloud.google.com/compute/instancesDetail/zones/${spec.region}/instances/${id}`,
};

const azure = {
  id: 'azure', label: 'Azure VM (az CLI)', auth: 'cli', cli: 'az', tokenHint: 'Uses the az login session of this machine; resource group "ascension" is created if missing',
  defaults: { region: 'westeurope', size: 'Standard_B1s', image: 'Ubuntu2404' },
  async available() { return !!(await probeTool('az', 'version')); },
  async create(_t, spec) {
    const ud = tmpFile('userdata', spec.userData);
    const pub = tmpFile('pub', spec.publicKey);
    try {
      await capture(`az group create --name ascension --location ${q(spec.region)} --output json`, { timeoutMs: 120000 });
      const out = JSON.parse(await capture(`az vm create --resource-group ascension --name ${q(spec.name)} --location ${q(spec.region)} --image ${q(spec.image)} --size ${q(spec.size)} --admin-username deploy --ssh-key-values ${q(pub)} --custom-data ${q(ud)} --public-ip-sku Standard --tags ascension=true --output json`, { timeoutMs: 600000 }));
      await capture(`az vm open-port --resource-group ascension --name ${q(spec.name)} --port 80,443 --priority 1001 --output none`, { timeoutMs: 180000 }).catch(() => {});
      return { id: spec.name, name: spec.name, ip: out.publicIpAddress || null };
    } finally { fs.unlinkSync(ud); fs.unlinkSync(pub); }
  },
  async status(_t, id) {
    const out = JSON.parse(await capture(`az vm show --resource-group ascension --name ${q(id)} --show-details --output json`, { timeoutMs: 120000 }));
    const ip = out.publicIps || null;
    return { status: /running/i.test(out.powerState || '') && ip ? 'ready' : 'creating', ip, raw: out.powerState };
  },
  async destroy(_t, id) { await capture(`az vm delete --resource-group ascension --name ${q(id)} --yes --output none`, { timeoutMs: 600000 }); },
  console: () => 'https://portal.azure.com/#view/HubsExtension/BrowseResource/resourceType/Microsoft.Compute%2FVirtualMachines',
};

module.exports = { aws, gcp, azure };
