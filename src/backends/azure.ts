import type { SecretClient } from "@azure/keyvault-secrets";
import { importPeer } from "../errors";
import { DeletePolicy, EnvironmentConfig } from "../types";
import { SecretBackend, SecretPayload, SecretVersion, versionsToDestroy } from "./types";

export function azureSecretName(name: string): string {
  return name.replace(/_/g, "-").replace(/[^a-zA-Z0-9-]/g, "-");
}

export class AzureBackend implements SecretBackend {
  readonly provider = "azure" as const;

  constructor(private readonly client: SecretClient) {}

  async get(name: string): Promise<SecretPayload> {
    const secret = await this.client.getSecret(azureSecretName(name));
    if (secret.value === undefined) {
      throw new Error(`No data found for secret ${name}`);
    }
    return { data: Buffer.from(secret.value, "utf8") };
  }

  async put(name: string, payload: SecretPayload): Promise<void> {
    const result = await this.client.setSecret(
      azureSecretName(name),
      payload.data.toString("utf8")
    );
    console.error(`Wrote secret ${name} version ${result.properties.version || "latest"}`);
  }

  async listVersions(name: string): Promise<SecretVersion[]> {
    const versions: SecretVersion[] = [];
    for await (const properties of this.client.listPropertiesOfSecretVersions(
      azureSecretName(name)
    )) {
      versions.push({
        id: properties.version || "",
        createdAt: properties.createdOn,
        enabled: properties.enabled !== false,
      });
    }
    return versions;
  }

  async destroyVersions(name: string, policy: DeletePolicy): Promise<void> {
    if (policy.enabled === false) {
      return;
    }

    try {
      const versions = await this.listVersions(name);
      const toDisable = versionsToDestroy(versions, policy);
      if (toDisable.length === 0) {
        return;
      }

      console.error(`Disabling ${toDisable.length} old version(s) of ${name}`);
      for (const version of toDisable) {
        if (!version.id) {
          continue;
        }
        try {
          await this.client.updateSecretProperties(azureSecretName(name), version.id, {
            enabled: false,
          });
        } catch (error) {
          console.warn(
            `   Warning: Could not disable version ${version.id}: ${(error as Error).message}`
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

export async function createAzureBackend(
  environment: EnvironmentConfig
): Promise<AzureBackend> {
  const [{ SecretClient }, { DefaultAzureCredential }] = await Promise.all([
    importPeer("azure", ["@azure/keyvault-secrets"], () =>
      import("@azure/keyvault-secrets")
    ),
    importPeer("azure", ["@azure/identity"], () => import("@azure/identity")),
  ]);

  if (!environment.vaultUrl) {
    throw new Error('Azure provider requires "vaultUrl"');
  }

  return new AzureBackend(
    new SecretClient(environment.vaultUrl, new DefaultAzureCredential())
  );
}
