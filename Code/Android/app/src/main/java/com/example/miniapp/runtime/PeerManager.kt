package com.example.miniapp.runtime

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.ServerSocket
import java.net.Socket
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.time.Instant
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

/**
 * Process-wide DNS-SD publisher/browser and opaque peer transport.  TCP endpoint
 * data and framing remain here; mini-apps can address only peer IDs and channels.
 */
object PeerManager {
    private const val SERVICE = "_miniapps-peer._tcp."
    private const val MAX_FRAME_BYTES = 64 * 1024
    private const val MAX_CHANNEL_LENGTH = 80
    private const val PROBE_PORT = 41234
    private val PROBE_REQUEST = "MAPD1?".toByteArray(Charsets.US_ASCII)
    private val PROBE_RESPONSE = "MAPD1!".toByteArray(Charsets.US_ASCII)
    private val peers = ConcurrentHashMap<String, Peer>()
    private val listeners = ConcurrentHashMap<String, (String, Any) -> Unit>()
    private val connections = ConcurrentHashMap<String, Connection>()
    private val channels = ConcurrentHashMap<String, Channel>()
    @Volatile private var started = false
    private var server: ServerSocket? = null
    private var nsd: NsdManager? = null
    private var discovery: NsdManager.DiscoveryListener? = null
    private var registration: NsdManager.RegistrationListener? = null
    private var probeSocket: DatagramSocket? = null
    private lateinit var deviceId: String

    private data class Peer(val id:String,val name:String,val platform:String,val version:String,val host:String,val port:Int,@Volatile var seen:Long)
    private data class Channel(val peerId:String,val appId:String,val name:String)
    private class Connection(val peerId:String,val socket:Socket,val input:DataInputStream,val output:DataOutputStream) {
        val writeLock = Any()
    }

    @Synchronized fun start(context:Context) {
        if (started) { scanLocalSubnet(); return }
        val app=context.applicationContext; val prefs=app.getSharedPreferences("peer-runtime",Context.MODE_PRIVATE)
        deviceId=prefs.getString("deviceId",null)?:UUID.randomUUID().toString().also{prefs.edit().putString("deviceId",it).apply()}
        server=ServerSocket(0).also { socket -> thread(name="miniapps-peer-listener",isDaemon=true){while(!socket.isClosed)runCatching{handleIncoming(socket.accept())}} }
        nsd=app.getSystemService(Context.NSD_SERVICE) as NsdManager
        val service=NsdServiceInfo().apply { serviceName="MiniApps-${deviceId.take(8)}";serviceType=SERVICE;port=server!!.localPort;setAttribute("protocolVersion","1");setAttribute("deviceId",deviceId);setAttribute("deviceName",android.os.Build.MODEL.take(80));setAttribute("platform","android");setAttribute("runtimeVersion","1.4.1") }
        registration=object:NsdManager.RegistrationListener{override fun onServiceRegistered(x:NsdServiceInfo){};override fun onRegistrationFailed(x:NsdServiceInfo,e:Int){};override fun onServiceUnregistered(x:NsdServiceInfo){};override fun onUnregistrationFailed(x:NsdServiceInfo,e:Int){}}
        nsd!!.registerService(service,NsdManager.PROTOCOL_DNS_SD,registration)
        discovery=object:NsdManager.DiscoveryListener{override fun onDiscoveryStarted(x:String){};override fun onDiscoveryStopped(x:String){};override fun onStartDiscoveryFailed(x:String,e:Int){stop()};override fun onStopDiscoveryFailed(x:String,e:Int){stop()};override fun onServiceLost(x:NsdServiceInfo){};override fun onServiceFound(x:NsdServiceInfo){if(x.serviceType!=SERVICE)return;nsd!!.resolveService(x,object:NsdManager.ResolveListener{override fun onResolveFailed(y:NsdServiceInfo,e:Int){};override fun onServiceResolved(y:NsdServiceInfo){val attributes=y.attributes;val id=attributes["deviceId"]?.toString(Charsets.UTF_8)?:return;if(id==deviceId)return;peers[id]=Peer(id,attributes["deviceName"]?.toString(Charsets.UTF_8)?:"Device",attributes["platform"]?.toString(Charsets.UTF_8)?:"unknown",attributes["runtimeVersion"]?.toString(Charsets.UTF_8)?:"unknown",y.host.hostAddress?:return,y.port,System.currentTimeMillis());notifyChanged()}})}}
        nsd!!.discoverServices(SERVICE,NsdManager.PROTOCOL_DNS_SD,discovery);started=true
        startProbeReceiver()
        scanLocalSubnet()
    }

    /** Explicit, bounded fallback for networks where multicast DNS is filtered. */
    private fun startProbeReceiver() {
        probeSocket=runCatching { DatagramSocket(null).apply { reuseAddress=true; bind(InetSocketAddress(PROBE_PORT)) } }.getOrNull()?:return
        val socket=probeSocket?:return
        thread(name="miniapps-peer-probe",isDaemon=true) {
            val buffer=ByteArray(1024)
            while(!socket.isClosed) runCatching {
                val packet=DatagramPacket(buffer,buffer.size);socket.receive(packet)
                val data=packet.data.copyOf(packet.length)
                when {
                    data.contentEquals(PROBE_REQUEST) -> {
                        val body=JSONObject().put("id",deviceId).put("name",android.os.Build.MODEL.take(80)).put("platform","android").put("version","1.4.1").put("port",server?.localPort?:0).toString().toByteArray(Charsets.UTF_8)
                        val reply=PROBE_RESPONSE+body;socket.send(DatagramPacket(reply,reply.size,packet.address,packet.port))
                    }
                    data.size>PROBE_RESPONSE.size && data.copyOfRange(0,PROBE_RESPONSE.size).contentEquals(PROBE_RESPONSE) -> {
                        val value=JSONObject(data.copyOfRange(PROBE_RESPONSE.size,data.size).toString(Charsets.UTF_8));val id=value.optString("id");val port=value.optInt("port")
                        val host=packet.address.hostAddress ?: return@runCatching
                        if(id.isNotBlank()&&id!=deviceId&&port in 1..65535){peers[id]=Peer(id,value.optString("name","Device"),value.optString("platform","unknown"),value.optString("version","unknown"),host,port,System.currentTimeMillis());notifyChanged()}
                    }
                }
            }
        }
    }

    /** Sends one minimal UDP discovery packet to x.x.x.1 through x.x.x.200. */
    fun scanLocalSubnet() {
        val socket=probeSocket?:return
        thread(name="miniapps-peer-scan",isDaemon=true) {
            val addresses=Collections.list(NetworkInterface.getNetworkInterfaces()).flatMap { network -> Collections.list(network.inetAddresses) }.filterIsInstance<Inet4Address>().filter { !it.isLoopbackAddress && it.isSiteLocalAddress }
            addresses.forEach { local ->
                val localHost=local.hostAddress ?: return@forEach
                val prefix=localHost.substringBeforeLast('.',"")
                if(prefix.isBlank()) return@forEach
                for(last in 1..200) { val host="$prefix.$last";if(host!=localHost)runCatching{socket.send(DatagramPacket(PROBE_REQUEST,PROBE_REQUEST.size,InetAddress.getByName(host),PROBE_PORT))} }
            }
        }
    }

    fun list():JSONArray { val cutoff=System.currentTimeMillis()-15_000;peers.entries.removeIf{it.value.seen<cutoff};return JSONArray(peers.values.map{JSONObject().put("id",it.id).put("name",it.name).put("platform",it.platform).put("runtimeVersion",it.version).put("status","available").put("connectionStatus",if(connections.containsKey(it.id))"connected" else "disconnected").put("lastSeenAt",Instant.ofEpochMilli(it.seen).toString())}) }
    fun connections():JSONArray = JSONArray(connections.keys.map { JSONObject().put("peerId",it).put("status","connected") })
    fun subscribe(appId:String, listener:(String, Any)->Unit){listeners[appId]=listener}
    fun unsubscribe(appId:String){listeners.remove(appId);channels.entries.removeIf{it.value.appId==appId}}
    private fun emit(appId:String,event:String,payload:Any){listeners[appId]?.let{runCatching{it(event,payload)}}}
    private fun emitAll(event:String,payload:Any){listeners.values.forEach{listener->runCatching{listener(event,payload)}}}
    private fun notifyChanged(){emitAll("peers.changed",list())}
    private fun channelKey(peerId:String,appId:String,name:String)="$peerId\u0000$appId\u0000$name"
    private fun channelName(value:String):String { if(value.isBlank()||value.length>MAX_CHANNEL_LENGTH||value.any{it<' '||it=='\u0000'})throw ApiException("invalid_params","Invalid channel name");return value }
    private fun peerId(value:String):String {if(value.isBlank()||value.length>64)throw ApiException("invalid_params","Invalid peer id");return value}

    fun connect(peerId:String){
        val id=peerId(peerId);val peer=peers[id]?:throw ApiException("peer_not_found","Peer was not found")
        if(connections.containsKey(id))return
        val socket=Socket(peer.host,peer.port)
        try { socket.soTimeout=10_000;val connection=Connection(id,socket,DataInputStream(socket.getInputStream()),DataOutputStream(socket.getOutputStream()));writeHello(connection.output);val remote=readHello(connection.input);if(remote!=id)throw ApiException("peer_handshake_failed","Peer identity did not match discovery");socket.soTimeout=0;registerConnection(connection) } catch(e:Exception){runCatching{socket.close()};throw e}
    }
    fun disconnect(peerId:String){closeConnection(peerId(peerId),"disconnected")}
    fun openChannel(appId:String,peerId:String,name:String):JSONObject {
        val id=peerId(peerId);val channel=channelName(name);requireConnection(id)
        val value=Channel(id,appId,channel);channels[channelKey(id,appId,channel)]=value
        sendFrame(id,JSONObject().put("type","channel.open").put("appId",appId).put("channel",channel))
        val result=channelPayload(id,channel);emit(appId,"peers.channelOpened",result);return result
    }
    fun closeChannel(appId:String,peerId:String,name:String):JSONObject {
        val id=peerId(peerId);val channel=channelName(name);val key=channelKey(id,appId,channel)
        if(channels.remove(key)==null)throw ApiException("peer_channel_not_found","Channel is not open")
        if(connections.containsKey(id))runCatching{sendFrame(id,JSONObject().put("type","channel.close").put("appId",appId).put("channel",channel))}
        val result=channelPayload(id,channel);emit(appId,"peers.channelClosed",result);return result
    }
    fun sendMessage(appId:String,peerId:String,name:String,message:Any?):JSONObject {
        val id=peerId(peerId);val channel=channelName(name)
        if(!channels.containsKey(channelKey(id,appId,channel)))throw ApiException("peer_channel_not_found","Channel is not open")
        val safe=JSONObject.wrap(message)?:JSONObject.NULL
        sendFrame(id,JSONObject().put("type","message").put("appId",appId).put("channel",channel).put("message",safe))
        return JSONObject().put("peerId",id).put("channel",channel)
    }

    private fun requireConnection(peerId:String):Connection=connections[peerId]?:throw ApiException("peer_not_connected","Peer is not connected")
    private fun registerConnection(connection:Connection) {
        val previous=connections.putIfAbsent(connection.peerId,connection)
        if(previous!=null){runCatching{connection.socket.close()};return}
        emitAll("peers.connectionChanged",JSONObject().put("peerId",connection.peerId).put("status","connected"));notifyChanged()
        thread(name="miniapps-peer-reader",isDaemon=true){readFrames(connection)}
    }
    private fun closeConnection(peerId:String,status:String){
        val connection=connections.remove(peerId)?:return;channels.entries.removeIf{it.value.peerId==peerId};runCatching{connection.socket.close()}
        emitAll("peers.connectionChanged",JSONObject().put("peerId",peerId).put("status",status));notifyChanged()
    }
    private fun handleIncoming(socket:Socket){thread(name="miniapps-peer-incoming",isDaemon=true){try{socket.soTimeout=10_000;val connection=Connection("",socket,DataInputStream(socket.getInputStream()),DataOutputStream(socket.getOutputStream()));val remote=readHello(connection.input);if(remote==deviceId)throw ApiException("peer_handshake_failed","Cannot connect to self");writeHello(connection.output);socket.soTimeout=0;registerConnection(Connection(remote,socket,connection.input,connection.output))}catch(_:Exception){runCatching{socket.close()}}}}
    private fun readFrames(connection:Connection){try{while(!connection.socket.isClosed)handleFrame(connection,readFrame(connection.input))}catch(_:Exception){}finally{closeConnection(connection.peerId,"disconnected")}}
    private fun handleFrame(connection:Connection,frame:JSONObject){
        val appId=frame.optString("appId");val channel=runCatching{channelName(frame.optString("channel"))}.getOrNull()?:return
        // An incoming frame is accepted only for a locally active manifest.  It
        // can never be re-routed to a different mini-app by a peer-supplied ID.
        if(appId.isBlank()||!listeners.containsKey(appId))return
        when(frame.optString("type")){
            "channel.open"->{channels[channelKey(connection.peerId,appId,channel)]=Channel(connection.peerId,appId,channel);emit(appId,"peers.channelOpened",channelPayload(connection.peerId,channel))}
            "channel.close"->{channels.remove(channelKey(connection.peerId,appId,channel));emit(appId,"peers.channelClosed",channelPayload(connection.peerId,channel))}
            "message"->{if(!channels.containsKey(channelKey(connection.peerId,appId,channel)))return;emit(appId,"peers.message",channelPayload(connection.peerId,channel).put("message",frame.opt("message")))}
        }
    }
    private fun channelPayload(peerId:String,channel:String)=JSONObject().put("peerId",peerId).put("channel",channel)
    private fun sendFrame(peerId:String,frame:JSONObject){val data=frame.toString().toByteArray(Charsets.UTF_8);if(data.size>MAX_FRAME_BYTES)throw ApiException("peer_message_too_large","Peer frame is too large");val connection=requireConnection(peerId);try{synchronized(connection.writeLock){connection.output.writeInt(data.size);connection.output.write(data);connection.output.flush()}}catch(_:Exception){closeConnection(peerId,"disconnected");throw ApiException("peer_connection_failed","Could not send to peer")}}
    private fun readFrame(input:DataInputStream):JSONObject {val size=input.readInt();if(size !in 2..MAX_FRAME_BYTES)throw ApiException("peer_protocol_error","Invalid peer frame");val data=ByteArray(size);input.readFully(data);return try{JSONObject(data.toString(Charsets.UTF_8))}catch(_:Exception){throw ApiException("peer_protocol_error","Invalid peer frame")}}
    private fun writeHello(output:DataOutputStream){val bytes=deviceId.toByteArray(Charsets.UTF_8);if(bytes.size !in 1..64)throw ApiException("peer_handshake_failed","Invalid local peer identity");output.write(byteArrayOf('M'.code.toByte(),'A'.code.toByte(),'P'.code.toByte(),'1'.code.toByte(),bytes.size.toByte()));output.write(bytes);output.flush()}
    private fun readHello(input:DataInputStream):String{val header=ByteArray(5);input.readFully(header);if(header[0]!='M'.code.toByte()||header[1]!='A'.code.toByte()||header[2]!='P'.code.toByte()||header[3]!='1'.code.toByte())throw ApiException("peer_handshake_failed","Invalid handshake magic");val size=header[4].toInt() and 0xff;if(size !in 1..64)throw ApiException("peer_handshake_failed","Invalid handshake frame");val bytes=ByteArray(size);input.readFully(bytes);return bytes.toString(Charsets.UTF_8).takeIf{it.length in 16..64}?:throw ApiException("peer_handshake_failed","Invalid peer identity")}
    @Synchronized fun stop(){if(!started)return;discovery?.let{runCatching{nsd?.stopServiceDiscovery(it)}};registration?.let{runCatching{nsd?.unregisterService(it)}};runCatching{probeSocket?.close()};probeSocket=null;runCatching{server?.close()};connections.keys.toList().forEach{closeConnection(it,"stopped")};channels.clear();peers.clear();started=false}
}
