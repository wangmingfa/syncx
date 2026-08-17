# Peer-to-Peer architecture without a central server

syncx is a LAN-focused file synchronizer for an individual's own devices, so every running instance is a full peer: devices connect pairwise and there is no central coordinator, discovery server, or single point of failure. A center-edge topology (Q2 option B) was rejected because it introduces a server to operate and a dependency for the whole mesh; true P2P complexity (global discovery, NAT traversal, relays) mostly disappears on a LAN where peers can reach each other directly.
