"""Advertise http://phoneboxsound.local on the network (mDNS/Bonjour).

iPhones, Macs and most recent Android/Windows devices resolve .local names; the IP address
still works everywhere as a fallback.
"""
import logging
import socket

log = logging.getLogger("pbs.mdns")


class Discovery:
    def __init__(self):
        self.zc = None
        self.info = None
        self.hostname = "phoneboxsound.local"

    async def start(self, ips, port):
        try:
            from zeroconf import IPVersion
            from zeroconf.asyncio import AsyncServiceInfo, AsyncZeroconf
        except ImportError:
            return False
        try:
            self.zc = AsyncZeroconf(ip_version=IPVersion.V4Only)
            self.info = AsyncServiceInfo(
                "_http._tcp.local.", "PhoneBoxSound._http._tcp.local.", port=port,
                addresses=[socket.inet_aton(ip) for ip in ips], server=self.hostname + ".",
                properties={"path": "/"})
            await self.zc.async_register_service(self.info, allow_name_change=True)
            log.info("advertising http://%s:%d", self.hostname, port)
            return True
        except Exception as e:
            log.info("mDNS unavailable: %s", e)
            self.zc = None
            return False

    async def stop(self):
        if self.zc:
            try:
                await self.zc.async_unregister_all_services()
                await self.zc.async_close()
            except Exception:
                pass
