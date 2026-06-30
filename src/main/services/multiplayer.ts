import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import sudo from "sudo-prompt";
import { exec } from "child_process";
import { HydraApi } from "./hydra-api";
import { logger } from "./logger";

export interface LobbyPeer {
  userId: string;
  username: string;
  virtualIp: string;
  wgPublicKey?: string;
}

export class MultiplayerService {
  private static activeLobbyId: string | null = null;
  private static activeSubnet: string | null = null;
  private static activeVirtualIp: string | null = null;
  private static heartbeatInterval: NodeJS.Timeout | null = null;
  private static isVpnActive = false;

  private static getWgConfPath(): string {
    return path.join(app.getPath("temp"), "hydra-wg.conf");
  }

  private static getWgTunnelName(): string {
    return "hydra-wg";
  }

  /**
   * Check if WireGuard is installed on the system
   */
  public static async isWireGuardInstalled(): Promise<boolean> {
    if (process.platform === "win32") {
      const defaultPath = "C:\\Program Files\\WireGuard\\wireguard.exe";
      if (fs.existsSync(defaultPath)) {
        return true;
      }
      return new Promise((resolve) => {
        exec("where wireguard", (error) => {
          resolve(!error);
        });
      });
    } else {
      return new Promise((resolve) => {
        exec("which wg-quick", (error) => {
          resolve(!error);
        });
      });
    }
  }

  /**
   * Downloads and installs WireGuard automatically (on-demand)
   */
  public static async installWireGuard(): Promise<void> {
    logger.info("[VPN] Initiating WireGuard installation...");
    
    if (process.platform === "win32") {
      const installerUrl = "https://download.wireguard.com/windows-client/wireguard-amd64-0.5.3.msi";
      const destPath = path.join(app.getPath("temp"), "wireguard-installer.msi");

      const https = await import("node:https");
      return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        https.get(installerUrl, (response) => {
          response.pipe(file);
          file.on("finish", () => {
            file.close();
            logger.info(`[VPN] WireGuard installer downloaded to ${destPath}. Executing...`);

            // Execute the installer silently
            const command = `msiexec /i "${destPath}" /passive /norestart`;
            sudo.exec(
              command,
              { name: "WireGuard Installer" },
              (sudoError, stdout, stderr) => {
                try { fs.unlinkSync(destPath); } catch {}
                if (sudoError) {
                  logger.error("[VPN] WireGuard installation failed:", sudoError);
                  reject(sudoError);
                } else {
                  logger.info("[VPN] WireGuard installed successfully");
                  resolve();
                }
              }
            );
          });
        }).on("error", (err) => {
          try { fs.unlinkSync(destPath); } catch {}
          logger.error("[VPN] Download failed:", err);
          reject(err);
        });
      });
    } else if (process.platform === "linux") {
      return new Promise((resolve, reject) => {
        const command = "apt-get update && apt-get install -y wireguard resolvconf";
        logger.info(`[VPN] Installing WireGuard via command: ${command}`);
        sudo.exec(
          command,
          { name: "WireGuard Installer" },
          (sudoError, stdout, stderr) => {
            if (sudoError) {
              logger.error("[VPN] Linux WireGuard installation failed:", sudoError);
              reject(sudoError);
            } else {
              logger.info("[VPN] Linux WireGuard installed successfully");
              resolve();
            }
          }
        );
      });
    } else {
      throw new Error(`WireGuard automatic installation is not supported on platform ${process.platform}. Please install it manually.`);
    }
  }

  /**
   * Create a new multiplayer lobby
   */
  public static async createLobby(
    gameId: string,
    title: string,
    userId: string,
    username: string
  ) {
    logger.info(`[Multiplayer] Creating lobby for game ${gameId} by user ${username}`);
    try {
      const response = await HydraApi.post<{
        lobbyId: string;
        subnet: string;
        virtualIp: string;
        wgConfig: string;
      }>("/multiplayer/lobbies", {
        gameId,
        title,
        hostId: userId,
        hostUsername: username,
      });

      this.activeLobbyId = response.lobbyId;
      this.activeSubnet = response.subnet;
      this.activeVirtualIp = response.virtualIp;

      // Start WireGuard connection
      await this.startVPN(response.wgConfig);

      // Start heartbeat
      this.startHeartbeat(response.lobbyId, userId);

      return {
        lobbyId: response.lobbyId,
        subnet: response.subnet,
        virtualIp: response.virtualIp,
        peers: [] as LobbyPeer[],
      };
    } catch (error) {
      logger.error("[Multiplayer] Failed to create lobby:", error);
      throw error;
    }
  }

  /**
   * Join an existing multiplayer lobby
   */
  public static async joinLobby(lobbyId: string, userId: string, username: string) {
    logger.info(`[Multiplayer] Joining lobby ${lobbyId} for user ${username}`);
    try {
      const response = await HydraApi.post<{
        lobbyId: string;
        subnet: string;
        virtualIp: string;
        wgConfig: string;
        peers: LobbyPeer[];
      }>(`/multiplayer/lobbies/${lobbyId}/join`, {
        userId,
        username,
      });

      this.activeLobbyId = response.lobbyId;
      this.activeSubnet = response.subnet;
      this.activeVirtualIp = response.virtualIp;

      // Start WireGuard connection
      await this.startVPN(response.wgConfig);

      // Start heartbeat
      this.startHeartbeat(response.lobbyId, userId);

      return {
        lobbyId: response.lobbyId,
        subnet: response.subnet,
        virtualIp: response.virtualIp,
        peers: response.peers,
      };
    } catch (error) {
      logger.error("[Multiplayer] Failed to join lobby:", error);
      throw error;
    }
  }

  /**
   * Leave the active lobby and stop the VPN connection
   */
  public static async leaveLobby(lobbyId: string, userId: string) {
    logger.info(`[Multiplayer] Leaving lobby ${lobbyId}`);
    
    // Stop heartbeat
    this.stopHeartbeat();

    // Stop VPN
    try {
      await this.stopVPN();
    } catch (error) {
      logger.error("[Multiplayer] Failed to stop VPN on leave:", error);
    }

    try {
      await HydraApi.post(`/multiplayer/lobbies/${lobbyId}/leave`, { userId });
    } catch (error) {
      logger.error("[Multiplayer] Failed to notify leave to API:", error);
    }

    this.activeLobbyId = null;
    this.activeSubnet = null;
    this.activeVirtualIp = null;
  }

  /**
   * Start WireGuard Client VPN tunnel
   */
  private static async startVPN(wgConfig: string): Promise<void> {
    const confPath = this.getWgConfPath();
    fs.writeFileSync(confPath, wgConfig, "utf8");
    logger.info(`[VPN] WireGuard configuration written to ${confPath}`);

    return new Promise((resolve, reject) => {
      let command = "";
      if (process.platform === "linux" || process.platform === "darwin") {
        command = `wg-quick up "${confPath}"`;
      } else if (process.platform === "win32") {
        const wgPath = "C:\\Program Files\\WireGuard\\wireguard.exe";
        command = `"${wgPath}" /installtunnelservice "${confPath}"`;
      } else {
        logger.warn(`[VPN] Unsupported platform ${process.platform}. Simulating connection...`);
        this.isVpnActive = true;
        return resolve();
      }

      logger.info(`[VPN] Executing elevated command: ${command}`);
      sudo.exec(
        command,
        { name: "Hydra Launcher VPN" },
        (sudoError, stdout, stderr) => {
          if (sudoError) {
            logger.error("[VPN] Failed to start WireGuard:", sudoError);
            if (stderr) logger.error("[VPN] Stderr:", stderr);
            reject(sudoError);
          } else {
            logger.info("[VPN] WireGuard VPN interface started successfully");
            if (stdout) logger.info("[VPN] Stdout:", stdout);
            this.isVpnActive = true;
            resolve();
          }
        }
      );
    });
  }

  /**
   * Stop WireGuard Client VPN tunnel
   */
  private static async stopVPN(): Promise<void> {
    if (!this.isVpnActive) {
      return;
    }

    const confPath = this.getWgConfPath();

    return new Promise((resolve, reject) => {
      let command = "";
      if (process.platform === "linux" || process.platform === "darwin") {
        command = `wg-quick down "${confPath}"`;
      } else if (process.platform === "win32") {
        const wgPath = "C:\\Program Files\\WireGuard\\wireguard.exe";
        command = `"${wgPath}" /uninstalltunnelservice ${this.getWgTunnelName()}`;
      } else {
        logger.info("[VPN] Simulating VPN teardown...");
        this.isVpnActive = false;
        try {
          if (fs.existsSync(confPath)) fs.unlinkSync(confPath);
        } catch {}
        return resolve();
      }

      logger.info(`[VPN] Executing elevated command to tear down: ${command}`);
      sudo.exec(
        command,
        { name: "Hydra Launcher VPN" },
        (sudoError, stdout, stderr) => {
          // Clean configuration file regardless of exit status
          try {
            if (fs.existsSync(confPath)) fs.unlinkSync(confPath);
          } catch {}

          if (sudoError) {
            logger.error("[VPN] Failed to stop WireGuard:", sudoError);
            if (stderr) logger.error("[VPN] Stderr:", stderr);
            reject(sudoError);
          } else {
            logger.info("[VPN] WireGuard VPN interface stopped successfully");
            if (stdout) logger.info("[VPN] Stdout:", stdout);
            this.isVpnActive = false;
            resolve();
          }
        }
      );
    });
  }

  /**
   * Sets up local game settings for Goldberg Steam Emulator
   */
  public static async setupGameVPN(executablePath: string, peerIps: string[]) {
    try {
      const gameDir = path.dirname(executablePath);
      const settingsDir = path.join(gameDir, "steam_settings");

      // 1. Create steam_settings folder if it does not exist
      if (!fs.existsSync(settingsDir)) {
        fs.mkdirSync(settingsDir, { recursive: true });
        logger.info(`[Goldberg] Created steam_settings folder at: ${settingsDir}`);
      }

      // 2. Write Goldberg's listen_ips.txt containing peers in the VPN
      const listenIpsPath = path.join(settingsDir, "listen_ips.txt");
      fs.writeFileSync(listenIpsPath, peerIps.join("\n"), "utf8");
      logger.info(`[Goldberg] Wrote listen_ips.txt to ${listenIpsPath}`);

      // 3. Write only_lan.txt with '1' to force Goldberg to LAN mode
      const onlyLanPath = path.join(settingsDir, "only_lan.txt");
      fs.writeFileSync(onlyLanPath, "1", "utf8");
      logger.info(`[Goldberg] Wrote only_lan.txt to ${onlyLanPath}`);

      return { success: true };
    } catch (error) {
      logger.error("[Goldberg] Failed to configure Goldberg settings:", error);
      throw error;
    }
  }

  /**
   * Start heartbeat loop to prevent API from pruning client
   */
  private static startHeartbeat(lobbyId: string, userId: string) {
    this.stopHeartbeat();

    this.heartbeatInterval = setInterval(async () => {
      try {
        await HydraApi.post(`/multiplayer/lobbies/${lobbyId}/heartbeat`, { userId });
      } catch (error) {
        logger.error("[Multiplayer] Heartbeat failed:", error);
      }
    }, 25000); // 25 seconds heartbeat
  }

  private static stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
}
