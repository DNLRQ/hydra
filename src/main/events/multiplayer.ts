import { registerEvent } from "./register-event";
import { MultiplayerService } from "@main/services";

const createLobby = async (
  _event: Electron.IpcMainInvokeEvent,
  gameId: string,
  title: string,
  userId: string,
  username: string
) => {
  return await MultiplayerService.createLobby(gameId, title, userId, username);
};

const joinLobby = async (
  _event: Electron.IpcMainInvokeEvent,
  lobbyId: string,
  userId: string,
  username: string
) => {
  return await MultiplayerService.joinLobby(lobbyId, userId, username);
};

const leaveLobby = async (
  _event: Electron.IpcMainInvokeEvent,
  lobbyId: string,
  userId: string
) => {
  return await MultiplayerService.leaveLobby(lobbyId, userId);
};

const setupGameVPN = async (
  _event: Electron.IpcMainInvokeEvent,
  executablePath: string,
  peerIps: string[]
) => {
  return await MultiplayerService.setupGameVPN(executablePath, peerIps);
};

const isWireGuardInstalled = async () => {
  return await MultiplayerService.isWireGuardInstalled();
};

const installWireGuard = async () => {
  return await MultiplayerService.installWireGuard();
};

registerEvent("multiplayer:createLobby", createLobby);
registerEvent("multiplayer:joinLobby", joinLobby);
registerEvent("multiplayer:leaveLobby", leaveLobby);
registerEvent("multiplayer:setupGameVPN", setupGameVPN);
registerEvent("multiplayer:isWireGuardInstalled", isWireGuardInstalled);
registerEvent("multiplayer:installWireGuard", installWireGuard);

