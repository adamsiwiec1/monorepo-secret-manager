import path from "path";
import type { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { importPeer } from "../errors";
import { DeletePolicy, EnvironmentConfig } from "../types";
import { SecretBackend, SecretPayload, SecretVersion, versionsToDestroy } from "./types";

export class GcpBackend implements SecretBackend {
  readonly provider = "gcp" as const;

  constructor(
    private readonly client: SecretManagerServiceClient,
    private readonly projectId: string
  ) {}

  private secretPath(name: string): string {
    return `projects/${this.projectId}/secrets/${name}`;
  }

  async get(name: string): Promise<SecretPayload> {
    const [version] = await this.client.accessSecretVersion({
      name: `${this.secretPath(name)}/versions/latest`,
    });

    if (!version.payload?.data) {
      throw new Error(`No data found for secret ${name}`);
    }

    return { data: Buffer.from(version.payload.data as Uint8Array) };
  }

  async put(name: string, payload: SecretPayload): Promise<void> {
    const secretPath = this.secretPath(name);

    try {
      await this.client.getSecret({ name: secretPath });
      const [version] = await this.client.addSecretVersion({
        parent: secretPath,
        payload: { data: payload.data },
      });
      console.error(`Updated secret ${name} with new version: ${version.name}`);
    } catch (error) {
      if (!(error as Error).message.includes("NOT_FOUND")) {
        throw error;
      }

      await this.client.createSecret({
        parent: `projects/${this.projectId}`,
        secretId: name,
        secret: {
          replication: {
            automatic: {},
          },
        },
      });

      const [version] = await this.client.addSecretVersion({
        parent: secretPath,
        payload: { data: payload.data },
      });
      console.error(`Created new secret ${name} with version: ${version.name}`);
    }
  }

  async listVersions(name: string): Promise<SecretVersion[]> {
    const [versions] = await this.client.listSecretVersions({
      parent: this.secretPath(name),
      pageSize: 100,
    });

    return (versions || []).map((version) => ({
      id: version.name || "",
      createdAt: version.createTime?.seconds
        ? new Date(Number(version.createTime.seconds) * 1000)
        : undefined,
      enabled: version.state === "ENABLED" || version.state === "DISABLED",
    }));
  }

  async destroyVersions(name: string, policy: DeletePolicy): Promise<void> {
    if (policy.enabled === false) {
      return;
    }

    try {
      const versions = await this.listVersions(name);
      const toDestroy = versionsToDestroy(versions, policy);

      if (toDestroy.length === 0) {
        return;
      }

      console.error(`Cleaning up ${toDestroy.length} old version(s) of ${name}`);
      for (const version of toDestroy) {
        if (!version.id) {
          continue;
        }
        try {
          await this.client.destroySecretVersion({ name: version.id });
          console.error(`   Destroyed version: ${version.id.split("/").pop()}`);
        } catch (error) {
          console.warn(
            `   Warning: Could not destroy version ${version.id}: ${(error as Error).message}`
          );
        }
      }
    } catch (error) {
      console.warn(
        `Warning: Could not clean up versions for ${name}: ${(error as Error).message}`
      );
    }
  }
}

export async function createGcpBackend(
  environment: EnvironmentConfig,
  overrideSa: boolean
): Promise<GcpBackend> {
  const { SecretManagerServiceClient } = await importPeer(
    "gcp",
    ["@google-cloud/secret-manager"],
    () => import("@google-cloud/secret-manager")
  );

  if (!environment.projectId) {
    throw new Error('GCP provider requires "projectId"');
  }

  const options: ConstructorParameters<typeof SecretManagerServiceClient>[0] = {
    projectId: environment.projectId,
  };

  if (!overrideSa && environment.credentials?.path) {
    const keyFilename = path.resolve(environment.credentials.path);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyFilename;
    options.keyFilename = keyFilename;
  }

  return new GcpBackend(new SecretManagerServiceClient(options), environment.projectId);
}
