"""Small, offline-capable ONVIF profile importer for a manually supplied endpoint.

This deliberately implements only the SOAP operations needed to obtain RTSP URIs.
It is not a full ONVIF client and does not perform WS-Discovery or fetch WSDLs.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import ipaddress
import math
import secrets
import socket
from datetime import datetime, timezone
from urllib.parse import quote, urljoin, urlsplit, urlunsplit
from uuid import uuid4
from xml.etree import ElementTree as ET

import httpx
from defusedxml import ElementTree as SafeET
from defusedxml.common import DefusedXmlException

SOAP = "http://www.w3.org/2003/05/soap-envelope"
DEVICE = "http://www.onvif.org/ver10/device/wsdl"
MEDIA1 = "http://www.onvif.org/ver10/media/wsdl"
MEDIA2 = "http://www.onvif.org/ver20/media/wsdl"
SCHEMA = "http://www.onvif.org/ver10/schema"
WSSE = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
WSU = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"
WSA = "http://www.w3.org/2005/08/addressing"
PASSWORD_DIGEST = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest"
BASE64_BINARY = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary"
MAX_SERVICES = 8
MAX_PROFILES_PER_SERVICE = 64
MAX_CONCURRENT_REQUESTS = 4
IMPORT_TIMEOUT_SECONDS = 75
DNS_TIMEOUT_SECONDS = 1
MAX_DNS_ADDRESSES = 8
MAX_DNS_HOSTS = 8


class OnvifError(ValueError):
    """A safe, user-facing import failure; never contains credentials or SOAP data."""


def _tag(namespace: str, name: str) -> str:
    return f"{{{namespace}}}{name}"


def _child(parent: ET.Element, namespace: str, name: str, value: str | None = None) -> ET.Element:
    node = ET.SubElement(parent, _tag(namespace, name))
    node.text = value
    return node


def _text(parent: ET.Element, name: str) -> str:
    node = parent.find(f".//{{*}}{name}")
    return (node.text or "").strip() if node is not None else ""


def _url(value: str, schemes: tuple[str, ...], *, allow_credentials: bool = False):
    try:
        if not isinstance(value, str) or not value or any(c.isspace() or ord(c) < 32 for c in value):
            raise ValueError
        parsed = urlsplit(value)
        if parsed.scheme.lower() not in schemes or not parsed.hostname or parsed.fragment:
            raise ValueError
        if not allow_credentials and (parsed.username is not None or parsed.password is not None):
            raise ValueError
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError
        return parsed
    except (ValueError, TypeError):
        raise OnvifError("Indirizzo ONVIF o URI RTSP non valido.") from None


def _replace_unspecified(value: str, camera_endpoint: str) -> str:
    parsed = urlsplit(value)
    if parsed.hostname not in ("0.0.0.0", "::"):
        return value
    host = urlsplit(camera_endpoint).hostname
    host = f"[{host}]" if ":" in host else host
    port = f":{parsed.port}" if parsed.port is not None else ""
    # Preserve any userinfo already supplied by the device, including escaping.
    userinfo = parsed.netloc.rsplit("@", 1)[0] + "@" if "@" in parsed.netloc else ""
    return urlunsplit(parsed._replace(netloc=f"{userinfo}{host}{port}"))


def _stream_url(value: str, camera_endpoint: str, username: str, password: str) -> str:
    parsed = _url(value, ("rtsp", "rtsps"), allow_credentials=True)
    value = _replace_unspecified(value, camera_endpoint)
    parsed = urlsplit(value)
    if parsed.username is None and username:
        userinfo = f"{quote(username, safe='')}:{quote(password, safe='')}@"
        value = urlunsplit(parsed._replace(netloc=userinfo + parsed.netloc))
    return value


def _clean_stream_url(value: str) -> str:
    """Remove only URI userinfo; query strings may still contain camera tokens."""
    parsed = urlsplit(value)
    return urlunsplit(parsed._replace(netloc=parsed.netloc.rsplit("@", 1)[-1]))


async def _resolve_host_ips(hostname: str) -> frozenset[str]:
    """Resolve only for same-device address comparison, with bounded waiting."""
    try:
        return frozenset([str(ipaddress.ip_address(hostname))])
    except ValueError:
        pass
    try:
        async with asyncio.timeout(DNS_TIMEOUT_SECONDS):
            addresses = await asyncio.get_running_loop().getaddrinfo(
                hostname, None, type=socket.SOCK_STREAM,
            )
        result = set()
        for address in addresses[:MAX_DNS_ADDRESSES]:
            try:
                result.add(str(ipaddress.ip_address(address[4][0])))
            except (ValueError, IndexError, TypeError):
                continue
        return frozenset(result)
    except (OSError, TimeoutError, UnicodeError):
        return frozenset()


def _direct_text(parent: ET.Element | None, name: str, *, strip: bool = True) -> str:
    if parent is None:
        return ""
    node = parent.find(f"{{*}}{name}")
    value = (node.text or "") if node is not None else ""
    return value.strip() if strip else value


def _number(parent: ET.Element | None, name: str, *, integer: bool = False):
    value = _direct_text(parent, name)
    try:
        number = int(value) if integer else float(value)
        return number if math.isfinite(number) and 0 < number <= 2_147_483_647 else None
    except (TypeError, ValueError, OverflowError):
        return None


def _profile_metadata(profile: ET.Element, namespace: str) -> dict:
    if namespace == MEDIA2:
        video = profile.find("{*}Configurations/{*}VideoEncoder")
        audio = profile.find("{*}Configurations/{*}AudioEncoder")
        source = profile.find("{*}Configurations/{*}VideoSource")
    else:
        video = profile.find("{*}VideoEncoderConfiguration")
        audio = profile.find("{*}AudioEncoderConfiguration")
        source = profile.find("{*}VideoSourceConfiguration")
    resolution = video.find("{*}Resolution") if video is not None else None
    rate = video.find("{*}RateControl") if video is not None else None
    fps = _number(rate, "FrameRateLimit")
    interval = _number(rate, "EncodingInterval", integer=True) if namespace == MEDIA1 else None
    if fps is not None and interval is not None:
        fps /= interval
    service = "Media2" if namespace == MEDIA2 else "Media1"
    return {
        "token": profile.get("token", ""),
        # Only the profile's own Name belongs here, never an encoder/source Name.
        "name": _direct_text(profile, "Name", strip=False),
        "encoding": _direct_text(video, "Encoding") or "unknown",
        "url": None,
        "clean_url": None,
        "width": _number(resolution, "Width", integer=True),
        "height": _number(resolution, "Height", integer=True),
        "fps": fps,
        # ONVIF BitrateLimit is expressed in kbps; this is not a measured bitrate.
        "bitrate": _number(rate, "BitrateLimit", integer=True),
        "audio_encoding": _direct_text(audio, "Encoding") or None,
        "video_source": _direct_text(source, "SourceToken", strip=False) or None,
        "service": service,
        "services": [service],
        "role": "other",
        "role_basis": "Metadati insufficienti per distinguere il ruolo del profilo.",
        "error": "Richiesta URI non completata.",
    }


def _merge_profiles(profiles: list[dict]) -> list[dict]:
    """Keep arbitrary tokens, merging only profiles with enough equal identity.

    URI equality alone never collapses different tokens or physical sources.
    Missing source identity prevents merging between different media services.
    """
    result: list[dict] = []
    for profile in profiles:
        duplicate = None
        for existing in result:
            if (existing["token"], existing["video_source"]) != (profile["token"], profile["video_source"]):
                continue
            same_service = profile["service"] in existing["services"]
            same_uri = existing["url"] == profile["url"]
            same_named_source = bool(profile["video_source"])
            retried_same_profile = same_service and (existing["url"] is None or profile["url"] is None)
            if retried_same_profile or (same_uri and (same_service or (same_named_source and profile["clean_url"]))):
                duplicate = existing
                break
        if duplicate is None:
            result.append(profile)
            continue
        for service in profile["services"]:
            if service not in duplicate["services"]:
                duplicate["services"].append(service)
        if duplicate["url"] is None and profile["url"] is not None:
            for key in ("url", "clean_url", "error"):
                duplicate[key] = profile[key]
        for key in ("width", "height", "fps", "bitrate", "audio_encoding"):
            if duplicate[key] is None and profile[key] is not None:
                duplicate[key] = profile[key]
        if duplicate["encoding"] == "unknown":
            duplicate["encoding"] = profile["encoding"]
    return result


def _infer_roles(profiles: list[dict]) -> None:
    """Offer source-local hints using declared geometry/bitrate, never names/order."""
    groups: dict[str, list[dict]] = {}
    for profile in profiles:
        source = profile["video_source"]
        if source is None:
            profile["role_basis"] = "Sorgente video non dichiarata: ruolo non determinabile."
        else:
            groups.setdefault(source, []).append(profile)
    for group in groups.values():
        sized = [(p, p["width"] * p["height"]) for p in group if p["width"] and p["height"]]
        areas = {area for _, area in sized}
        rated = [(p, p["bitrate"]) for p in group if p["bitrate"]]
        bitrates = {rate for _, rate in rated}
        if len(group) == 1 and (sized or rated):
            group[0]["role"] = "main"
            group[0]["role_basis"] = "Unico profilo con risoluzione o bitrate dichiarato per questa sorgente; ruolo indicativo."
            continue
        if len(areas) > 1:
            ranked = sized
            basis = "risoluzione"
        elif len(bitrates) > 1 and (not sized or len(sized) == len(group)):
            ranked = rated
            basis = "bitrate dichiarato"
        else:
            for profile in group:
                profile["role_basis"] = "Metadati equivalenti o incompleti per questa sorgente: ruolo non distinguibile."
            continue
        largest = max(value for _, value in ranked)
        smallest = min(value for _, value in ranked)
        for profile, value in ranked:
            if value == largest:
                profile["role"] = "main"
                profile["role_basis"] = f"Valore massimo di {basis} tra i profili dichiarati per questa sorgente; ruolo indicativo."
            elif value == smallest:
                profile["role"] = "sub"
                profile["role_basis"] = f"Valore minimo di {basis} tra i profili dichiarati per questa sorgente; ruolo indicativo."
            else:
                profile["role_basis"] = f"{basis.capitalize()} intermedio per questa sorgente; ruolo indicativo."


def _envelope(namespace: str, operation: str, endpoint: str, username: str, password: str,
              arguments: list[tuple[str, str, str]] | None = None) -> bytes:
    root = ET.Element(_tag(SOAP, "Envelope"))
    header = _child(root, SOAP, "Header")
    _child(header, WSA, "Action", namespace + "/" + operation)
    _child(header, WSA, "To", endpoint)
    _child(header, WSA, "MessageID", "urn:uuid:" + str(uuid4()))
    if username:
        security = _child(header, WSSE, "Security")
        security.set(_tag(SOAP, "mustUnderstand"), "1")
        token = _child(security, WSSE, "UsernameToken")
        _child(token, WSSE, "Username", username)
        nonce = secrets.token_bytes(16)
        created = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        digest = base64.b64encode(hashlib.sha1(nonce + created.encode() + password.encode()).digest()).decode()
        _child(token, WSSE, "Password", digest).set("Type", PASSWORD_DIGEST)
        _child(token, WSSE, "Nonce", base64.b64encode(nonce).decode()).set("EncodingType", BASE64_BINARY)
        _child(token, WSU, "Created", created)
    body = _child(root, SOAP, "Body")
    request = _child(body, namespace, operation)
    for arg_namespace, name, value in arguments or []:
        _child(request, arg_namespace, name, value)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


async def _soap(client: httpx.AsyncClient, endpoint: str, namespace: str, operation: str,
                username: str, password: str, arguments=None) -> ET.Element:
    content = _envelope(namespace, operation, endpoint, username, password, arguments)
    if operation == "GetStreamUri" and namespace == MEDIA1:
        root = ET.fromstring(content)
        request = root.find(f"{{{SOAP}}}Body/{{{MEDIA1}}}GetStreamUri")
        setup = ET.Element(_tag(MEDIA1, "StreamSetup"))
        _child(setup, SCHEMA, "Stream", "RTP-Unicast")
        transport = _child(setup, SCHEMA, "Transport")
        _child(transport, SCHEMA, "Protocol", "RTSP")
        request.insert(0, setup)
        content = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    try:
        async with client.stream("POST", endpoint, content=content, headers={
            "Content-Type": f'application/soap+xml; charset=utf-8; action="{namespace}/{operation}"',
            "SOAPAction": f'"{namespace}/{operation}"',
        }) as response:
            if response.status_code in (401, 403):
                raise OnvifError("Autenticazione ONVIF rifiutata: controllare utente, password e orologio della telecamera.")
            xml = bytearray()
            async for chunk in response.aiter_bytes(65536):
                if len(xml) + len(chunk) > 2 * 1024 * 1024:
                    raise OnvifError("Risposta ONVIF troppo grande.")
                xml.extend(chunk)
        root = SafeET.fromstring(xml, forbid_dtd=True)
        fault = root.find(".//{*}Fault")
        if fault is not None:
            codes = [(node.text or "").strip().rsplit(":", 1)[-1] for node in fault.iter()
                     if node.tag.rsplit("}", 1)[-1] in ("Value", "faultcode")]
            if any(code in ("NotAuthorized", "FailedAuthentication", "InvalidSecurity", "MessageExpired") for code in codes):
                raise OnvifError("Autenticazione ONVIF rifiutata: controllare utente, password e orologio della telecamera.")
            raise OnvifError("Operazione ONVIF non disponibile o rifiutata dalla telecamera.")
        response.raise_for_status()
        body = root.find(f"{{{SOAP}}}Body")
        # A few older devices respond using SOAP 1.1 envelopes.
        if body is None:
            body = root.find("{http://schemas.xmlsoap.org/soap/envelope/}Body")
        if body is None or body.find(f"{{*}}{operation}Response") is None:
            raise OnvifError("La telecamera ha restituito una risposta ONVIF inattesa.")
        return body
    except (httpx.HTTPError, ET.ParseError, DefusedXmlException):
        raise OnvifError("Connessione ONVIF fallita o risposta XML non valida.") from None


async def get_profiles(endpoint: str, username: str = "", password: str = "") -> dict:
    """Enumerate the device's Media1 and Media2 profiles, including URI failures.

    Missing optional device information never blocks profile import. A report
    with profiles but no usable URI has success=False; failure to enumerate any
    profile raises OnvifError. Both URL fields are administrator-only data:
    clean_url removes userinfo but may retain tokens in the camera's query.
    """
    endpoint_parts = _url(endpoint, ("http", "https"))
    endpoint_host = endpoint_parts.hostname.lower()
    candidates: list[tuple[str, str]] = []
    profiles: list[dict] = []
    warnings: list[str] = []
    device = {name: None for name in ("manufacturer", "model", "firmware", "serial_number", "hardware_id")}
    last_error = OnvifError("Nessun profilo disponibile: verificare endpoint, credenziali e servizi ONVIF.")
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_REQUESTS)
    resolved_hosts: dict[str, frozenset[str]] = {}

    def warn(message: str):
        if message not in warnings:
            warnings.append(message)

    async def host_ips(hostname: str) -> frozenset[str]:
        if hostname not in resolved_hosts:
            if len(resolved_hosts) >= MAX_DNS_HOSTS:
                return frozenset()
            resolved_hosts[hostname] = await _resolve_host_ips(hostname)
        return resolved_hosts[hostname]

    async def add(namespace: str, address: str):
        if namespace not in (MEDIA1, MEDIA2) or not address:
            return
        try:
            address = urljoin(endpoint, address)
            _url(address, ("http", "https"))
            address = _replace_unspecified(address, endpoint)
            advertised = _url(address, ("http", "https"))
        except (OnvifError, ValueError):
            warn("Un indirizzo di servizio Media dichiarato dalla telecamera non è valido ed è stato ignorato.")
            return
        if (namespace, address) in candidates:
            return
        if len(candidates) >= MAX_SERVICES:
            warn(f"La telecamera dichiara più di {MAX_SERVICES} servizi Media: elenco limitato.")
            return
        advertised_host = advertised.hostname.lower()
        if advertised_host != endpoint_host:
            original_ips = await host_ips(endpoint_host)
            alternate_ips = await host_ips(advertised_host) if original_ips else frozenset()
            if not original_ips.intersection(alternate_ips):
                warn("Un servizio Media indica un host diverso dal dispositivo che non è stato possibile verificare: indirizzo ignorato.")
                return
        candidates.append((namespace, address))

    auth = httpx.DigestAuth(username, password) if username else None
    async with httpx.AsyncClient(auth=auth, timeout=httpx.Timeout(8.0), follow_redirects=False,
                                 trust_env=False) as client:
        async def request(address: str, namespace: str, operation: str, arguments=None):
            async with semaphore:
                return await _soap(client, address, namespace, operation, username, password, arguments)

        async def resolve(profile: dict, namespace: str, address: str):
            arguments = [(namespace, "ProfileToken", profile["token"])]
            if namespace == MEDIA2:
                arguments.insert(0, (namespace, "Protocol", "RTSP"))
            try:
                stream = await request(address, namespace, "GetStreamUri", arguments)
                profile["url"] = _stream_url(_text(stream, "Uri"), endpoint, username, password)
                profile["clean_url"] = _clean_stream_url(profile["url"])
                profile["error"] = None
            except OnvifError as error:
                profile["error"] = str(error)

        async def enumerate_service(namespace: str, address: str):
            nonlocal last_error
            service = "Media2" if namespace == MEDIA2 else "Media1"
            try:
                arguments = [(MEDIA2, "Type", kind) for kind in ("VideoEncoder", "VideoSource", "AudioEncoder")] if namespace == MEDIA2 else []
                result = await request(address, namespace, "GetProfiles", arguments)
            except OnvifError as error:
                last_error = error
                warn(f"Impossibile leggere i profili {service}. {error}")
                return
            nodes = result.findall(".//{*}Profiles")
            if len(nodes) > MAX_PROFILES_PER_SERVICE:
                warn(f"Il servizio {service} dichiara più di {MAX_PROFILES_PER_SERVICE} profili: elenco limitato.")
            service_profiles = []
            for node in nodes[:MAX_PROFILES_PER_SERVICE]:
                if not node.get("token"):
                    warn(f"Un profilo {service} senza token è stato ignorato.")
                    continue
                profile = _profile_metadata(node, namespace)
                profiles.append(profile)
                service_profiles.append(profile)
            await asyncio.gather(*(resolve(profile, namespace, address) for profile in service_profiles))

        async def collect():
            nonlocal last_error
            services, capabilities, information = await asyncio.gather(
                request(endpoint, DEVICE, "GetServices", [(DEVICE, "IncludeCapability", "false")]),
                request(endpoint, DEVICE, "GetCapabilities", [(DEVICE, "Category", "Media")]),
                request(endpoint, DEVICE, "GetDeviceInformation"), return_exceptions=True,
            )
            if isinstance(services, OnvifError):
                last_error = services
            else:
                if isinstance(services, BaseException):
                    raise services
                for service in services.findall(".//{*}Service"):
                    await add(_text(service, "Namespace"), _text(service, "XAddr"))
            if isinstance(capabilities, OnvifError):
                last_error = capabilities
            else:
                if isinstance(capabilities, BaseException):
                    raise capabilities
                for media in capabilities.findall(".//{*}Media"):
                    await add(MEDIA1, _text(media, "XAddr"))
            if isinstance(information, OnvifError):
                warn("Informazioni del dispositivo non disponibili; i profili possono comunque essere consultati.")
            else:
                if isinstance(information, BaseException):
                    raise information
                for field, xml_name in (("manufacturer", "Manufacturer"), ("model", "Model"),
                                        ("firmware", "FirmwareVersion"), ("serial_number", "SerialNumber"),
                                        ("hardware_id", "HardwareId")):
                    device[field] = _text(information, xml_name) or None
            candidates.sort(key=lambda candidate: candidate[0] != MEDIA2)
            advertised = list(candidates)
            await asyncio.gather(*(enumerate_service(namespace, address) for namespace, address in advertised))
            # Direct Media endpoints remain supported. Avoid querying a Device
            # endpoint redundantly once its advertised services returned URIs.
            if not any(profile["url"] for profile in profiles):
                await add(MEDIA2, endpoint)
                await add(MEDIA1, endpoint)
                fallback = [candidate for candidate in candidates if candidate not in advertised]
                await asyncio.gather(*(enumerate_service(namespace, address) for namespace, address in fallback))

        try:
            async with asyncio.timeout(IMPORT_TIMEOUT_SECONDS):
                await collect()
        except TimeoutError:
            warn("Tempo massimo di consultazione ONVIF raggiunto: il risultato può essere incompleto.")
            last_error = OnvifError("Tempo massimo di consultazione ONVIF raggiunto; controllare connessione e servizi della telecamera.")
    if not profiles:
        raise last_error
    profiles = _merge_profiles(profiles)
    _infer_roles(profiles)
    failed = sum(profile["url"] is None for profile in profiles)
    if failed:
        warn(f"URI RTSP non disponibile per {failed} profili: gli altri indirizzi restano utilizzabili.")
    return {"device": device, "profiles": profiles, "warnings": warnings,
            "success": any(profile["url"] is not None for profile in profiles)}
